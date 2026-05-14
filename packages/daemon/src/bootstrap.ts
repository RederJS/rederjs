import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Logger } from 'pino';
import { createLogger } from '@rederjs/core/logger';
import { loadConfig, type Config } from '@rederjs/core/config';
import { openDatabase, type DatabaseHandle } from '@rederjs/core/storage/db';
import { createSession } from '@rederjs/core/sessions';
import { createIpcServer, type IpcServer } from '@rederjs/core/ipc/server';
import { createRouter, type Router } from '@rederjs/core/router';
import { createAuditLog, type AuditLog } from '@rederjs/core/audit';
import {
  startHealthEndpoint,
  type HealthEndpoint,
  type HealthSnapshot,
} from '@rederjs/core/health';
import { startSession as startTmuxSession, getPaneCommand } from '@rederjs/core/tmux';
import type { Adapter } from '@rederjs/core/adapter';
import { createAdapterHost, type AdapterHost, loadAdapter } from './adapter-host.js';
export type { AdapterHost };

/**
 * Best-effort check that the Claude Code hooks were installed in a session's
 * workspace. Lives in the `rederjs` (CLI) package — daemon dynamically imports
 * it so the daemon can be installed/run without the CLI present (and to avoid
 * a circular npm dep). If the CLI isn't on the module path, the check is
 * silently skipped — it only drives a warning log, not behavior.
 */
async function checkClaudeHooks(args: {
  projectDir: string;
  sessionId: string;
}): Promise<boolean | null> {
  try {
    const mod = (await import('rederjs/commands/claude-hooks')) as {
      hasClaudeHooks: (a: { projectDir: string; sessionId: string }) => boolean;
    };
    return mod.hasClaudeHooks(args);
  } catch {
    return null;
  }
}

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
  const configDir = dirname(configPath);
  const config = loadConfig(configPath);

  const runtimeDir = expandHome(config.runtime.runtime_dir);
  const dataDir = expandHome(config.runtime.data_dir);
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const logger = createLogger({ level: config.logging.level });
  logger.info(
    { configPath, runtimeDir, dataDir, component: 'daemon.bootstrap' },
    'starting rederd',
  );

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
        'session not previously registered; generated fresh token (run `reder sessions add` to retrieve it)',
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
    dataDir,
  });

  const daemonVersion = opts.daemonVersion ?? '0.1.0';

  // Forward-reference to adapter host — set after we construct it below.
  let adapterHostRef: AdapterHost | null = null;

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
        .prepare(`SELECT session_id, state, last_seen_at FROM sessions ORDER BY session_id`)
        .all() as Array<{
        session_id: string;
        state: 'registered' | 'connected' | 'disconnected' | 'revoked';
        last_seen_at: string | null;
      }>
    ).map((r) => ({ session_id: r.session_id, state: r.state, last_seen_at: r.last_seen_at }));

    const adapterSnaps = [];
    const entries = adapterHostRef?.loaded ?? [];
    for (const entry of entries) {
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

  const adapterHost = await createAdapterHost({
    db: db.raw,
    config,
    logger,
    audit,
    router,
    dataDir,
    configDir,
    resolveModule: opts.overrideResolveModule ?? loadAdapter,
    healthSnapshot: snapshotFn,
  });
  adapterHostRef = adapterHost;

  await adapterHost.startAll((name, adapter: Adapter) => {
    router.registerAdapter(name, { adapter });
  });

  // Auto-start tmux sessions for entries with auto_start:true + workspace_dir.
  // Non-fatal; log each start/skip/failure.
  for (const s of config.sessions) {
    if (!s.auto_start || !s.workspace_dir) continue;
    const result = startTmuxSession({
      session_id: s.session_id,
      workspace_dir: s.workspace_dir,
      permission_mode: s.permission_mode,
      logger: logger.child({ component: 'core.tmux' }),
    });
    logger.info(
      {
        session_id: s.session_id,
        workspace_dir: s.workspace_dir,
        ...result,
        component: 'daemon.bootstrap',
      },
      result.started ? 'auto-started tmux session' : 'tmux auto-start skipped',
    );

    // A tmux session can outlive its `claude` process (manual ctrl+D, crash,
    // etc.). `isRunning` only checks that the session exists, so auto-start
    // silently skips stale sessions. Detect and warn.
    if (result.reason === 'already_running') {
      const paneCmd = getPaneCommand(s.session_id);
      if (paneCmd !== null && paneCmd !== 'claude') {
        logger.warn(
          {
            session_id: s.session_id,
            workspace_dir: s.workspace_dir,
            pane_current_command: paneCmd,
            component: 'daemon.bootstrap',
          },
          `tmux session '${s.session_id}' is running but pane is '${paneCmd}' (not claude). ` +
            `Run \`reder sessions restart ${s.session_id}\` to relaunch.`,
        );
      }
    }
  }

  // Warn about sessions that are auto-started but missing their Claude hook
  // config. Best-effort — if the CLI package isn't installed alongside the
  // daemon, the check returns null and we skip the warning.
  for (const s of config.sessions) {
    if (!s.auto_start || !s.workspace_dir) continue;
    const present = await checkClaudeHooks({
      projectDir: s.workspace_dir,
      sessionId: s.session_id,
    });
    if (present === false) {
      logger.warn(
        {
          session_id: s.session_id,
          workspace_dir: s.workspace_dir,
          component: 'daemon.bootstrap',
        },
        "claude hook config missing — dashboard activity status will show 'unknown'. Run `reder sessions repair " +
          s.session_id +
          '`',
      );
    }
  }

  // Legacy health endpoint: only start if the web adapter isn't enabled.
  // When enabled, adapter-web serves `/health` on the same port as the dashboard.
  const webAdapterEnabled = Boolean(config.adapters['web']?.enabled);
  let health: HealthEndpoint | null = null;
  if (config.health.enabled && !webAdapterEnabled) {
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
