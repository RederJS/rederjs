import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Logger } from 'pino';
import { createLogger } from '@reder/core/logger';
import { loadConfig, type Config } from '@reder/core/config';
import { openDatabase, type DatabaseHandle } from '@reder/core/storage/db';
import { createSession } from '@reder/core/sessions';
import { createIpcServer, type IpcServer } from '@reder/core/ipc/server';
import { createRouter, type Router } from '@reder/core/router';
import { createAuditLog, type AuditLog } from '@reder/core/audit';
import { startHealthEndpoint, type HealthEndpoint, type HealthSnapshot } from '@reder/core/health';
import type { Adapter } from '@reder/core/adapter';
import { createAdapterHost, type AdapterHost, loadAdapter } from './adapter-host.js';

export interface BootstrapResult {
  config: Config;
  configPath: string;
  logger: Logger;
  db: DatabaseHandle;
  ipcServer: IpcServer;
  router: Router;
  audit: AuditLog;
  health: HealthEndpoint | null;
  adapterHost: AdapterHost;
  startedAt: Date;
  stop(): Promise<void>;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return resolve(p);
}

export interface BootstrapOptions {
  configPath: string;
  overrideResolveModule?: (spec: string) => Promise<Awaited<ReturnType<typeof loadAdapter>>>;
  daemonVersion?: string;
}

export async function bootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const startedAt = new Date();
  const configPath = resolve(opts.configPath);
  const config = loadConfig(configPath);

  const runtimeDir = expandHome(config.runtime.runtime_dir);
  const dataDir = expandHome(config.runtime.data_dir);
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const logger = createLogger({ level: config.logging.level });
  logger.info({ configPath, runtimeDir, dataDir, component: 'daemon.bootstrap' }, 'starting rederd');

  const audit = createAuditLog(runtimeDir);
  const db = openDatabase(join(dataDir, 'reder.db'));

  // Ensure sessions declared in config exist in DB (registered state).
  for (const s of config.sessions) {
    const existing = db.raw
      .prepare('SELECT session_id FROM sessions WHERE session_id = ?')
      .get(s.session_id);
    if (!existing) {
      const { token } = await createSession(db.raw, s.session_id, s.display_name);
      logger.warn(
        { session_id: s.session_id, component: 'daemon.bootstrap' },
        'session not previously registered; generated fresh token (run `reder install` to retrieve it)',
      );
      // Token is logged only at trace to avoid persistent leakage
      logger.trace({ token, session_id: s.session_id }, 'generated session token');
    }
  }

  const ipcSocket = join(runtimeDir, 'rederd.sock');
  const ipcServer = await createIpcServer({
    db: db.raw,
    socketPath: ipcSocket,
    logger: logger.child({ component: 'ipc.server' }),
  });

  const router = createRouter({
    db: db.raw,
    ipcServer,
    logger: logger.child({ component: 'core.router' }),
    audit,
    permissions: {
      timeoutSeconds: config.security.permission_timeout_seconds,
      defaultOnTimeout: config.security.permission_default_on_timeout,
    },
  });

  const adapterHost = await createAdapterHost({
    db: db.raw,
    config,
    logger,
    audit,
    router,
    dataDir,
    resolveModule: opts.overrideResolveModule ?? loadAdapter,
  });

  await adapterHost.startAll((name, adapter: Adapter) => {
    router.registerAdapter(name, { adapter });
  });

  let health: HealthEndpoint | null = null;
  if (config.health.enabled) {
    const daemonVersion = opts.daemonVersion ?? '0.1.0';
    const snapshotFn = async (): Promise<HealthSnapshot> => {
      const inbound = (
        db.raw
          .prepare(
            `SELECT COUNT(*) AS c FROM inbound_messages WHERE state IN ('received','delivered')`,
          )
          .get() as { c: number }
      ).c;
      const outbound = (
        db.raw
          .prepare(`SELECT COUNT(*) AS c FROM outbound_messages WHERE state = 'pending'`)
          .get() as { c: number }
      ).c;
      const sessions = (
        db.raw
          .prepare(
            `SELECT session_id, state, last_seen_at FROM sessions ORDER BY session_id`,
          )
          .all() as Array<{
          session_id: string;
          state: 'registered' | 'connected' | 'disconnected' | 'revoked';
          last_seen_at: string | null;
        }>
      ).map((r) => ({ session_id: r.session_id, state: r.state, last_seen_at: r.last_seen_at }));

      const adapterSnaps = [];
      for (const entry of adapterHost.loaded) {
        const h = entry.adapter.healthCheck ? await entry.adapter.healthCheck() : null;
        adapterSnaps.push({
          name: entry.name,
          healthy: h?.healthy ?? true,
          connected_since: h?.connectedSince?.toISOString() ?? null,
          last_inbound_at: h?.lastInboundAt?.toISOString() ?? null,
          last_outbound_at: h?.lastOutboundAt?.toISOString() ?? null,
          details: h?.details ?? {},
        });
      }
      return {
        daemon: {
          uptime_s: Math.round((Date.now() - startedAt.getTime()) / 1000),
          started_at: startedAt.toISOString(),
          config_path: configPath,
          version: daemonVersion,
        },
        adapters: adapterSnaps,
        outbox: { inbound_pending: inbound, outbound_pending: outbound },
        sessions,
      };
    };
    health = await startHealthEndpoint({
      bind: config.health.bind,
      port: config.health.port,
      snapshot: snapshotFn,
      logger: logger.child({ component: 'core.health' }),
    });
  }

  const stop = async (): Promise<void> => {
    logger.info({ component: 'daemon.bootstrap' }, 'stopping rederd');
    if (health) await health.close();
    await adapterHost.stopAll();
    await router.stop();
    await ipcServer.close();
    db.close();
    audit.close();
    logger.info({ component: 'daemon.bootstrap' }, 'rederd stopped');
  };

  return {
    config,
    configPath,
    logger,
    db,
    ipcServer,
    router,
    audit,
    health,
    adapterHost,
    startedAt,
    stop,
  };
}
