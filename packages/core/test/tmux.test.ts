import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isRunning,
  listRunning,
  startSession,
  tmuxHealth,
  InvalidTmuxName,
  type TmuxRunner,
} from '../src/tmux.js';

interface Call {
  args: readonly string[];
  input?: string;
}

function makeRunner(responses: Array<{ status: number; stdout?: string; stderr?: string }>): {
  runner: TmuxRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const runner: TmuxRunner = (args, input) => {
    calls.push({ args, ...(input !== undefined ? { input } : {}) });
    const resp = responses[i++] ?? { status: 0 };
    return {
      status: resp.status,
      stdout: Buffer.from(resp.stdout ?? ''),
      stderr: Buffer.from(resp.stderr ?? ''),
    };
  };
  return { runner, calls };
}

describe('tmux.isRunning', () => {
  it('returns true when tmux has-session exits 0', () => {
    const { runner, calls } = makeRunner([{ status: 0 }]);
    expect(isRunning('reder', { runner })).toBe(true);
    expect(calls[0]?.args).toEqual(['has-session', '-t=reder']);
  });

  it('returns false when tmux has-session exits nonzero', () => {
    const { runner } = makeRunner([{ status: 1, stderr: 'session not found' }]);
    expect(isRunning('reder', { runner })).toBe(false);
  });

  it('rejects invalid tmux names', () => {
    const { runner } = makeRunner([]);
    expect(() => isRunning('bad name!', { runner })).toThrow(InvalidTmuxName);
  });
});

describe('tmux.listRunning', () => {
  it('parses list-sessions output into names', () => {
    const { runner } = makeRunner([{ status: 0, stdout: 'reder\ncaddy\nmango\n' }]);
    expect(listRunning({ runner })).toEqual(['reder', 'caddy', 'mango']);
  });

  it('returns empty array on failure', () => {
    const { runner } = makeRunner([{ status: 1, stderr: 'no server' }]);
    expect(listRunning({ runner })).toEqual([]);
  });

  it('handles blank lines and trailing whitespace', () => {
    const { runner } = makeRunner([{ status: 0, stdout: '\nreder\n\ncaddy\n' }]);
    expect(listRunning({ runner })).toEqual(['reder', 'caddy']);
  });
});

describe('tmux.startSession', () => {
  let tmpDir: string;
  let workspace: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reder-tmux-test-'));
    workspace = join(tmpDir, 'ws');
    mkdirSync(workspace);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips when session already running', () => {
    const { runner, calls } = makeRunner([{ status: 0 }]); // has-session → 0
    const result = startSession({ session_id: 'reder', workspace_dir: workspace, runner });
    expect(result).toEqual({ started: false, reason: 'already_running' });
    expect(calls).toHaveLength(1);
  });

  it('fails when workspace missing', () => {
    const { runner, calls } = makeRunner([{ status: 1 }]); // has-session → 1
    const result = startSession({
      session_id: 'reder',
      workspace_dir: join(tmpDir, 'does-not-exist'),
      runner,
    });
    expect(result.started).toBe(false);
    expect(result.reason).toBe('missing_dir');
    expect(calls).toHaveLength(1);
  });

  it('starts claude with the channels flag enabled by default', () => {
    const { runner, calls } = makeRunner([
      { status: 1 }, // has-session → not running
      { status: 0 }, // new-session
    ]);
    const result = startSession({ session_id: 'reder', workspace_dir: workspace, runner });
    expect(result).toEqual({ started: true });
    expect(calls[1]?.args).toEqual([
      'new-session',
      '-d',
      '-s',
      'reder',
      '-c',
      workspace,
      'claude',
      '--dangerously-load-development-channels',
      'server:reder',
    ]);
  });

  it('injects --permission-mode when permission_mode is set', () => {
    const { runner, calls } = makeRunner([{ status: 1 }, { status: 0 }]);
    startSession({
      session_id: 'reder',
      workspace_dir: workspace,
      permission_mode: 'plan',
      runner,
    });
    const args = calls[1]?.args ?? [];
    const claudeIdx = args.indexOf('claude');
    expect(args.slice(claudeIdx)).toEqual([
      'claude',
      '--permission-mode',
      'plan',
      '--dangerously-load-development-channels',
      'server:reder',
    ]);
  });

  it('omits --permission-mode when mode is default', () => {
    const { runner, calls } = makeRunner([{ status: 1 }, { status: 0 }]);
    startSession({
      session_id: 'reder',
      workspace_dir: workspace,
      permission_mode: 'default',
      runner,
    });
    const args = calls[1]?.args ?? [];
    expect(args).not.toContain('--permission-mode');
  });

  it('leaves caller-supplied command untouched even when permission_mode is set', () => {
    const { runner, calls } = makeRunner([{ status: 1 }, { status: 0 }]);
    startSession({
      session_id: 'reder',
      workspace_dir: workspace,
      command: ['claude', '--custom'],
      permission_mode: 'plan',
      runner,
    });
    const args = calls[1]?.args ?? [];
    expect(args.slice(-2)).toEqual(['claude', '--custom']);
    expect(args).not.toContain('--permission-mode');
  });

  it('uses custom command argv when provided', () => {
    const { runner, calls } = makeRunner([{ status: 1 }, { status: 0 }]);
    startSession({
      session_id: 'reder',
      workspace_dir: workspace,
      command: ['claude', '--dangerously-skip-permissions'],
      runner,
    });
    expect(calls[1]?.args.slice(-2)).toEqual(['claude', '--dangerously-skip-permissions']);
  });

  it('returns tmux_error when new-session fails', () => {
    const { runner } = makeRunner([{ status: 1 }, { status: 1, stderr: 'no tmux server' }]);
    const result = startSession({ session_id: 'reder', workspace_dir: workspace, runner });
    expect(result).toEqual({
      started: false,
      reason: 'tmux_error',
      error: 'no tmux server',
    });
  });

  it('rejects invalid tmux session names without calling tmux', () => {
    const { runner, calls } = makeRunner([]);
    const result = startSession({
      session_id: 'has space',
      workspace_dir: workspace,
      runner,
    });
    expect(result.started).toBe(false);
    expect(result.reason).toBe('invalid_name');
    expect(calls).toHaveLength(0);
  });

  it('expands ~ in workspace_dir', () => {
    // Use $HOME-relative path — existsSync should resolve against homedir.
    const { runner, calls } = makeRunner([{ status: 1 }, { status: 0 }]);
    // ~ expands to homedir; use homedir itself which always exists.
    const result = startSession({
      session_id: 'reder',
      workspace_dir: '~',
      runner,
    });
    expect(result.started).toBe(true);
    // The -c arg should be an absolute path, not the literal '~'.
    const newSessionArgs = calls[1]?.args ?? [];
    const cIdx = newSessionArgs.indexOf('-c');
    expect(newSessionArgs[cIdx + 1]).not.toBe('~');
    expect(newSessionArgs[cIdx + 1]).toMatch(/^\//);
  });
});

describe('tmux.tmuxHealth', () => {
  it('reports installed and version', () => {
    const { runner } = makeRunner([{ status: 0, stdout: 'tmux 3.3a' }]);
    expect(tmuxHealth({ runner })).toEqual({ installed: true, version: 'tmux 3.3a' });
  });

  it('reports not installed on nonzero exit', () => {
    const { runner } = makeRunner([{ status: 127, stderr: 'command not found' }]);
    expect(tmuxHealth({ runner })).toEqual({
      installed: false,
      error: 'command not found',
    });
  });
});
