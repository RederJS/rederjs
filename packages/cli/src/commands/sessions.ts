import { loadConfigContext } from '../config-loader.js';
import {
  isRunning,
  killSession,
  listRunning,
  startSession,
  type PermissionMode,
} from '@rederjs/core/tmux';

export interface SessionListEntry {
  session_id: string;
  display_name: string;
  workspace_dir: string | null;
  auto_start: boolean;
  permission_mode: PermissionMode;
  tmux_running: boolean;
}

export interface SessionsListResult {
  sessions: SessionListEntry[];
  orphan_tmux: string[];
}

export function runSessionsList(opts: { configPath?: string } = {}): SessionsListResult {
  const ctx = loadConfigContext(opts.configPath);
  const knownIds = new Set(ctx.config.sessions.map((s) => s.session_id));
  const running = new Set(listRunning());
  const sessions: SessionListEntry[] = ctx.config.sessions.map((s) => ({
    session_id: s.session_id,
    display_name: s.display_name,
    workspace_dir: s.workspace_dir ?? null,
    auto_start: s.auto_start,
    permission_mode: s.permission_mode,
    tmux_running: running.has(s.session_id),
  }));
  const orphan_tmux = [...running].filter((n) => !knownIds.has(n));
  return { sessions, orphan_tmux };
}

export function formatSessionsList(r: SessionsListResult): string {
  if (r.sessions.length === 0) return 'No sessions configured.';
  const rows = [['ID', 'Name', 'Workspace', 'Auto', 'Mode', 'Tmux']];
  for (const s of r.sessions) {
    rows.push([
      s.session_id,
      s.display_name,
      s.workspace_dir ?? '-',
      s.auto_start ? 'yes' : 'no',
      s.permission_mode,
      s.tmux_running ? '✓' : ' ',
    ]);
  }
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? '').length)));
  const lines = rows.map((row) => row.map((c, i) => c.padEnd(widths[i]!)).join('  '));
  if (r.orphan_tmux.length > 0) {
    lines.push('', `Orphan tmux sessions (not in config): ${r.orphan_tmux.join(', ')}`);
  }
  return lines.join('\n');
}

export interface SessionStartResult {
  session_id: string;
  started: boolean;
  reason?: string;
  error?: string;
}

export function runSessionStart(opts: {
  sessionId: string;
  configPath?: string;
}): SessionStartResult {
  const ctx = loadConfigContext(opts.configPath);
  const s = ctx.config.sessions.find((x) => x.session_id === opts.sessionId);
  if (!s) {
    return {
      session_id: opts.sessionId,
      started: false,
      reason: 'not_in_config',
      error: `session '${opts.sessionId}' not in config.sessions[]`,
    };
  }
  if (!s.workspace_dir) {
    return {
      session_id: opts.sessionId,
      started: false,
      reason: 'no_workspace_dir',
      error: `session '${opts.sessionId}' has no workspace_dir; cannot start tmux`,
    };
  }
  const result = startSession({
    session_id: s.session_id,
    workspace_dir: s.workspace_dir,
    permission_mode: s.permission_mode,
  });
  return {
    session_id: s.session_id,
    started: result.started,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

export function formatSessionStart(r: SessionStartResult): string {
  if (r.started) return `✓ started ${r.session_id}`;
  if (r.reason === 'already_running') return `• ${r.session_id} (already running)`;
  return `✗ ${r.session_id}: ${r.error ?? r.reason ?? 'failed'}`;
}

export interface SessionsUpResult {
  results: SessionStartResult[];
}

/**
 * Iterate every session with a workspace_dir and attempt to start it.
 * Mirrors the user's bash script. Idempotent.
 */
export function runSessionsUp(opts: { configPath?: string } = {}): SessionsUpResult {
  const ctx = loadConfigContext(opts.configPath);
  const results: SessionStartResult[] = [];
  for (const s of ctx.config.sessions) {
    if (!s.workspace_dir) continue;
    const result = startSession({
      session_id: s.session_id,
      workspace_dir: s.workspace_dir,
      permission_mode: s.permission_mode,
    });
    results.push({
      session_id: s.session_id,
      started: result.started,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
  }
  return { results };
}

export function formatSessionsUp(r: SessionsUpResult): string {
  if (r.results.length === 0) return 'No sessions with workspace_dir configured.';
  return r.results.map(formatSessionStart).join('\n');
}

export interface SessionRestartResult {
  session_id: string;
  killed: boolean;
  started: boolean;
  reason?: string;
  error?: string;
}

/**
 * Kill the tmux session (if any) and start it fresh. Used to recover sessions
 * where tmux is alive but its pane stopped running `claude`.
 */
export function runSessionRestart(opts: {
  sessionId: string;
  configPath?: string;
}): SessionRestartResult {
  const ctx = loadConfigContext(opts.configPath);
  const s = ctx.config.sessions.find((x) => x.session_id === opts.sessionId);
  if (!s) {
    return {
      session_id: opts.sessionId,
      killed: false,
      started: false,
      reason: 'not_in_config',
      error: `session '${opts.sessionId}' not in config.sessions[]`,
    };
  }
  if (!s.workspace_dir) {
    return {
      session_id: opts.sessionId,
      killed: false,
      started: false,
      reason: 'no_workspace_dir',
      error: `session '${opts.sessionId}' has no workspace_dir; cannot restart tmux`,
    };
  }
  const wasRunning = isRunning(s.session_id);
  const killed = wasRunning ? killSession(s.session_id) : false;
  const result = startSession({
    session_id: s.session_id,
    workspace_dir: s.workspace_dir,
    permission_mode: s.permission_mode,
  });
  return {
    session_id: s.session_id,
    killed,
    started: result.started,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

export function formatSessionRestart(r: SessionRestartResult): string {
  if (!r.started) return `✗ ${r.session_id}: ${r.error ?? r.reason ?? 'failed'}`;
  if (r.killed) return `✓ restarted ${r.session_id} (killed stale tmux first)`;
  return `✓ started ${r.session_id}`;
}

// Re-exported helper for other CLI commands / tests.
export { isRunning };
