import { existsSync } from 'node:fs';
import prompts from 'prompts';
import { loadConfigContext } from '../config-loader.js';
import { defaultConfigPath } from '../paths.js';
import { peekSession } from './config-writer.js';
import { runSessionAdd, ConfigNotFoundError, type SessionAddResult } from './sessions-add.js';
import { SessionNotFoundError } from './sessions-remove.js';

export interface SessionRepairOptions {
  sessionId: string;
  configPath?: string | undefined;
  shimCommand?: readonly string[] | undefined;
}

export async function runSessionRepair(opts: SessionRepairOptions): Promise<SessionAddResult> {
  const configPath = opts.configPath ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    throw new ConfigNotFoundError(configPath);
  }
  const existing = peekSession({ configPath, sessionId: opts.sessionId });
  if (!existing) throw new SessionNotFoundError(opts.sessionId);
  if (!existing.workspace_dir) {
    throw new Error(
      `Session '${opts.sessionId}' has no workspace_dir; nothing to repair (add one first).`,
    );
  }
  // Load context just to validate it parses cleanly.
  loadConfigContext(configPath);

  return runSessionAdd({
    sessionId: opts.sessionId,
    displayName: existing.display_name,
    projectDir: existing.workspace_dir,
    configPath,
    ...(opts.shimCommand !== undefined ? { shimCommand: opts.shimCommand } : {}),
    autoStart: existing.auto_start ?? false,
    ...(existing.permission_mode !== undefined ? { permissionMode: existing.permission_mode } : {}),
    forceRebind: true,
  });
}

export interface SessionRepairAllOptions {
  configPath?: string | undefined;
  shimCommand?: readonly string[] | undefined;
}

export type SessionRepairOutcome =
  | { sessionId: string; ok: true; result: SessionAddResult }
  | { sessionId: string; ok: false; reason: 'no_workspace_dir' | 'error'; error: string };

export interface SessionRepairAllResult {
  results: SessionRepairOutcome[];
}

/**
 * Repair every registered session. Sessions without a workspace_dir are
 * skipped with a structured `no_workspace_dir` outcome rather than failing the
 * whole batch — matches the behavior of single-session repair which throws on
 * that case, but here we keep going.
 */
export async function runSessionRepairAll(
  opts: SessionRepairAllOptions = {},
): Promise<SessionRepairAllResult> {
  const configPath = opts.configPath ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    throw new ConfigNotFoundError(configPath);
  }
  const ctx = loadConfigContext(configPath);
  const results: SessionRepairOutcome[] = [];
  for (const s of ctx.config.sessions) {
    if (!s.workspace_dir) {
      results.push({
        sessionId: s.session_id,
        ok: false,
        reason: 'no_workspace_dir',
        error: `session '${s.session_id}' has no workspace_dir; skipped`,
      });
      continue;
    }
    try {
      const result = await runSessionRepair({
        sessionId: s.session_id,
        configPath,
        ...(opts.shimCommand !== undefined ? { shimCommand: opts.shimCommand } : {}),
      });
      results.push({ sessionId: s.session_id, ok: true, result });
    } catch (err) {
      results.push({
        sessionId: s.session_id,
        ok: false,
        reason: 'error',
        error: (err as Error).message,
      });
    }
  }
  return { results };
}

export interface InteractiveSessionRepairOptions {
  sessionIdArg?: string | undefined;
  all?: boolean | undefined;
  configPath?: string | undefined;
  shimCommand?: readonly string[] | undefined;
  nonInteractive?: boolean | undefined;
}

export type InteractiveSessionRepairResult =
  | { kind: 'single'; result: SessionAddResult }
  | { kind: 'all'; result: SessionRepairAllResult }
  | { kind: 'cancelled' };

/**
 * Resolve a session id (or "all") and dispatch to the right repair function.
 * Three modes:
 *   - `sessionIdArg` provided → repair that one session
 *   - `all` set → repair every session
 *   - neither → prompt the user (TTY) or throw (non-interactive)
 */
export async function interactiveSessionRepair(
  opts: InteractiveSessionRepairOptions,
): Promise<InteractiveSessionRepairResult> {
  const configPath = opts.configPath ?? defaultConfigPath();
  if (!existsSync(configPath)) {
    throw new ConfigNotFoundError(configPath);
  }

  if (opts.all) {
    const result = await runSessionRepairAll({
      configPath,
      ...(opts.shimCommand !== undefined ? { shimCommand: opts.shimCommand } : {}),
    });
    return { kind: 'all', result };
  }

  if (opts.sessionIdArg !== undefined && opts.sessionIdArg.length > 0) {
    const result = await runSessionRepair({
      sessionId: opts.sessionIdArg,
      configPath,
      ...(opts.shimCommand !== undefined ? { shimCommand: opts.shimCommand } : {}),
    });
    return { kind: 'single', result };
  }

  const ctx = loadConfigContext(configPath);
  const sessions = ctx.config.sessions;
  if (sessions.length === 0) {
    throw new Error('No sessions configured. Run `reder sessions add` first.');
  }

  const canInteract = !opts.nonInteractive && Boolean(process.stdin.isTTY);
  if (!canInteract) {
    throw new Error(
      'reder sessions repair requires either a <session-id> argument or --all in non-interactive mode.',
    );
  }

  const choices: Array<{ title: string; value: string; description?: string }> = sessions.map(
    (s) => ({
      title: `${s.session_id}${s.display_name && s.display_name !== s.session_id ? ` (${s.display_name})` : ''}`,
      value: s.session_id,
      description: s.workspace_dir ?? '(no workspace_dir)',
    }),
  );
  choices.push({
    title: 'All sessions',
    value: '__all__',
    description: `Repair all ${sessions.length} session${sessions.length === 1 ? '' : 's'}`,
  });

  const { choice } = (await prompts({
    type: 'select',
    name: 'choice',
    message: 'Which session do you want to repair?',
    choices,
    initial: 0,
  })) as { choice?: string };

  if (choice === undefined) return { kind: 'cancelled' };

  if (choice === '__all__') {
    const result = await runSessionRepairAll({
      configPath,
      ...(opts.shimCommand !== undefined ? { shimCommand: opts.shimCommand } : {}),
    });
    return { kind: 'all', result };
  }

  const result = await runSessionRepair({
    sessionId: choice,
    configPath,
    ...(opts.shimCommand !== undefined ? { shimCommand: opts.shimCommand } : {}),
  });
  return { kind: 'single', result };
}
