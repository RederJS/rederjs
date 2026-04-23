import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';

export type TmuxRunner = (
  args: readonly string[],
  input?: string,
) => Pick<SpawnSyncReturns<Buffer>, 'status' | 'stdout' | 'stderr'>;

const defaultRunner: TmuxRunner = (args, input) =>
  spawnSync('tmux', args, {
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

const TMUX_TARGET_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export class InvalidTmuxName extends Error {
  override readonly name = 'InvalidTmuxName';
}

function assertValidName(name: string): void {
  if (!TMUX_TARGET_RE.test(name)) {
    throw new InvalidTmuxName(`invalid tmux session name '${name}' (must match ${TMUX_TARGET_RE})`);
  }
}

export function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

export interface TmuxRunnerOption {
  runner?: TmuxRunner;
}

export function isRunning(name: string, opts: TmuxRunnerOption = {}): boolean {
  assertValidName(name);
  const run = opts.runner ?? defaultRunner;
  const result = run(['has-session', `-t=${name}`]);
  return result.status === 0;
}

/**
 * Return the current command running in the first pane of a tmux session,
 * or null if the session doesn't exist. Useful for detecting "tmux alive
 * but its process (e.g. `claude`) has since exited" — where `isRunning`
 * returns true but the session is effectively stale.
 */
export function getPaneCommand(name: string, opts: TmuxRunnerOption = {}): string | null {
  assertValidName(name);
  const run = opts.runner ?? defaultRunner;
  const result = run(['list-panes', '-F', '#{pane_current_command}', '-t', name]);
  if (result.status !== 0) return null;
  const out = result.stdout?.toString('utf8') ?? '';
  const first = out.split('\n').map((s) => s.trim()).find((s) => s.length > 0);
  return first ?? null;
}

/**
 * Kill a tmux session by name. Returns true if tmux exited 0 (session was
 * killed or didn't exist), false on error. `force: true` suppresses
 * "session not found" stderr noise from the caller's perspective.
 */
export function killSession(name: string, opts: TmuxRunnerOption = {}): boolean {
  assertValidName(name);
  const run = opts.runner ?? defaultRunner;
  const result = run(['kill-session', '-t', name]);
  return result.status === 0;
}

export function listRunning(opts: TmuxRunnerOption = {}): string[] {
  const run = opts.runner ?? defaultRunner;
  const result = run(['list-sessions', '-F', '#{session_name}']);
  if (result.status !== 0) return [];
  const out = result.stdout?.toString('utf8') ?? '';
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

export type StartReason = 'already_running' | 'missing_dir' | 'tmux_error' | 'invalid_name';

export const PERMISSION_MODES = [
  'default',
  'plan',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface StartSessionOptions extends TmuxRunnerOption {
  session_id: string;
  workspace_dir: string;
  command?: readonly string[];
  permission_mode?: PermissionMode;
  env?: Record<string, string>;
  logger?: Logger;
}

export const DEFAULT_CLAUDE_COMMAND: readonly string[] = ['claude'];

function buildDefaultCommand(mode: PermissionMode | undefined): readonly string[] {
  if (mode === undefined || mode === 'default') return DEFAULT_CLAUDE_COMMAND;
  const [head, ...rest] = DEFAULT_CLAUDE_COMMAND;
  return [head!, '--permission-mode', mode, ...rest];
}

export interface StartSessionResult {
  started: boolean;
  reason?: StartReason;
  error?: string;
}

export function startSession(opts: StartSessionOptions): StartSessionResult {
  const { session_id, workspace_dir } = opts;
  const command = opts.command ?? buildDefaultCommand(opts.permission_mode);

  try {
    assertValidName(session_id);
  } catch (err) {
    return { started: false, reason: 'invalid_name', error: (err as Error).message };
  }

  const run = opts.runner ?? defaultRunner;
  const dir = expandHome(workspace_dir);

  if (isRunning(session_id, { runner: run })) {
    opts.logger?.info(
      { session_id, component: 'core.tmux' },
      'tmux session already running; skipping',
    );
    return { started: false, reason: 'already_running' };
  }

  if (!existsSync(dir)) {
    opts.logger?.warn(
      { session_id, dir, component: 'core.tmux' },
      'workspace directory missing; cannot start tmux session',
    );
    return { started: false, reason: 'missing_dir', error: `missing directory: ${dir}` };
  }

  const args = ['new-session', '-d', '-s', session_id, '-c', dir];
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      args.push('-e', `${k}=${v}`);
    }
  }
  args.push(...command);

  const result = run(args);
  if (result.status !== 0) {
    const stderr = result.stderr?.toString('utf8').trim() ?? '';
    opts.logger?.error(
      { session_id, dir, stderr, component: 'core.tmux' },
      'tmux new-session failed',
    );
    return { started: false, reason: 'tmux_error', error: stderr || 'tmux exited nonzero' };
  }

  opts.logger?.info(
    { session_id, dir, command: command.join(' '), component: 'core.tmux' },
    'started tmux session',
  );
  return { started: true };
}

export interface TmuxHealth {
  installed: boolean;
  version?: string;
  error?: string;
}

export function tmuxHealth(opts: TmuxRunnerOption = {}): TmuxHealth {
  const run = opts.runner ?? defaultRunner;
  try {
    const result = run(['-V']);
    if (result.status !== 0) {
      return { installed: false, error: result.stderr?.toString('utf8').trim() ?? 'nonzero exit' };
    }
    return { installed: true, version: result.stdout?.toString('utf8').trim() };
  } catch (err) {
    return { installed: false, error: (err as Error).message };
  }
}
