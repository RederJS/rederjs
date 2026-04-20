import { dirname } from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import type { Logger } from 'pino';
import {
  Adapter,
  type AdapterContext,
  type RouterHandle,
} from '@reder/core/adapter';
import { createAdapterStorage } from '@reder/core/storage/kv';
import type { AuditLog } from '@reder/core/audit';
import type { Config } from '@reder/core/config';

export interface AdapterFactory {
  (cfg: unknown): Promise<Adapter> | Adapter;
}

export interface AdapterHostDeps {
  db: Db;
  config: Config;
  logger: Logger;
  audit: AuditLog;
  router: RouterHandle;
  dataDir: string;
  resolveModule: (spec: string) => Promise<AdapterFactory>;
}

export interface LoadedAdapter {
  name: string;
  module: string;
  adapter: Adapter;
}

export async function loadAdapter(spec: string): Promise<AdapterFactory> {
  const imported = (await import(spec)) as {
    default?: unknown;
    createAdapter?: AdapterFactory;
  };
  if (typeof imported.createAdapter === 'function') {
    return imported.createAdapter;
  }
  const exported = imported.default;
  if (typeof exported === 'function') {
    return (async (cfg: unknown) => {
      const AdapterClass = exported as new (cfg: unknown) => Adapter;
      return new AdapterClass(cfg);
    }) as AdapterFactory;
  }
  throw new Error(
    `adapter module '${spec}' must export either a default Adapter class or a createAdapter() function`,
  );
}

export interface AdapterHost {
  readonly loaded: readonly LoadedAdapter[];
  startAll(register: (name: string, adapter: Adapter) => void): Promise<void>;
  stopAll(): Promise<void>;
}

export async function createAdapterHost(deps: AdapterHostDeps): Promise<AdapterHost> {
  const loaded: LoadedAdapter[] = [];

  for (const [name, cfg] of Object.entries(deps.config.adapters)) {
    if (!cfg.enabled) continue;
    const adapterLogger = deps.logger.child({ component: `adapter.${name}`, adapter_module: cfg.module });
    try {
      const factory = await deps.resolveModule(cfg.module);
      const adapter = await factory(cfg.config);
      loaded.push({ name, module: cfg.module, adapter });
      if (!cfg.module.startsWith('@reder/')) {
        adapterLogger.warn({ module: cfg.module }, 'third-party adapter loaded');
      }
    } catch (err) {
      adapterLogger.error({ err }, 'failed to load adapter; skipping');
      deps.audit.write({ kind: 'adapter_start', adapter: name, details: { error: String(err), failed: true } });
    }
  }

  return {
    get loaded(): readonly LoadedAdapter[] {
      return loaded;
    },
    async startAll(register) {
      for (const entry of loaded) {
        const logger = deps.logger.child({ component: `adapter.${entry.name}` });
        const ctx: AdapterContext = {
          logger,
          config: deps.config.adapters[entry.name]?.config,
          storage: createAdapterStorage(deps.db, entry.name),
          router: deps.router,
          dataDir: deps.dataDir,
        };
        try {
          await entry.adapter.start(ctx);
          register(entry.name, entry.adapter);
          deps.audit.write({ kind: 'adapter_start', adapter: entry.name });
          logger.info('adapter started');
        } catch (err) {
          logger.error({ err }, 'adapter start failed');
          deps.audit.write({
            kind: 'adapter_start',
            adapter: entry.name,
            details: { error: String(err), failed: true },
          });
        }
      }
    },
    async stopAll() {
      for (const entry of loaded) {
        try {
          await entry.adapter.stop();
          deps.audit.write({ kind: 'adapter_stop', adapter: entry.name });
        } catch (err) {
          deps.logger.error({ err, adapter: entry.name }, 'adapter stop failed');
        }
      }
    },
  };
}

// Silence unused-import warnings for types re-used in JSDoc elsewhere
void dirname;
