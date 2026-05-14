import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installClaudeHooks,
  removeClaudeHooks,
  hasClaudeHooks,
  type HookInstallParams,
} from '../src/commands/claude-hooks.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-hooks-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function params(overrides: Partial<HookInstallParams> = {}): HookInstallParams {
  return {
    projectDir: dir,
    sessionId: 'sess',
    hookCommand: '/usr/local/bin/reder-hook',
    socketPath: '/tmp/reder.sock',
    tokenFilePath: '/home/user/.local/share/reder/data/sessions/sess/shim.token',
    ...overrides,
  };
}

function settingsPath(): string {
  return join(dir, '.claude', 'settings.local.json');
}

describe('installClaudeHooks', () => {
  it('creates settings.local.json with the three required hooks', () => {
    installClaudeHooks(params());
    const doc = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    expect(Object.keys(doc.hooks)).toEqual(
      expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'Stop']),
    );
  });

  it('preserves pre-existing user hooks', () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] }],
        },
      }),
    );
    installClaudeHooks(params());
    const doc = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(doc.hooks.PostToolUse).toHaveLength(1);
    expect(doc.hooks.UserPromptSubmit).toBeDefined();
  });

  it('is idempotent — running twice does not duplicate entries', () => {
    installClaudeHooks(params());
    installClaudeHooks(params());
    const doc = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(doc.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('updates the command path on re-install with new tokenFilePath', () => {
    installClaudeHooks(params({ tokenFilePath: '/var/reder/sessions/sess/old.token' }));
    installClaudeHooks(params({ tokenFilePath: '/var/reder/sessions/sess/new.token' }));
    const doc = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(doc.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toContain('new.token');
    expect(doc.hooks.UserPromptSubmit[0]!.hooks[0]!.command).not.toContain('old.token');
  });

  it('emits --token-file (not --token) so the secret never appears on argv', () => {
    installClaudeHooks(params({ tokenFilePath: '/var/reder/sessions/sess/shim.token' }));
    const doc = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const cmd = doc.hooks.UserPromptSubmit[0]!.hooks[0]!.command;
    expect(cmd).toContain("--token-file '/var/reder/sessions/sess/shim.token'");
    // Regression: hook command must not contain a `--token '<value>'` literal.
    expect(cmd).not.toMatch(/--token\s+'[^']*'/);
  });

  it('strips legacy unmarked entries on re-install (same session-id, --token inline)', () => {
    // Pre-seed settings.local.json with a legacy entry written by an older
    // shim: bare `reder-hook` command, inline --token, no _reder_session_id
    // marker. Repair / re-install must remove this rather than appending a
    // duplicate that fires a now-stale token on every event.
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command:
                    "'reder-hook' --session-id 'sess' --socket '/tmp/reder.sock' " +
                    "--token 'rdr_sess_legacy_inline_secret' --hook UserPromptSubmit",
                },
              ],
            },
          ],
        },
      }),
    );
    installClaudeHooks(params());
    const doc = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(doc.hooks.UserPromptSubmit).toHaveLength(1);
    const cmd = doc.hooks.UserPromptSubmit[0]!.hooks[0]!.command;
    expect(cmd).toContain('--token-file');
    expect(cmd).not.toContain('rdr_sess_legacy_inline_secret');
  });

  it('preserves legacy unmarked entries that belong to a different session', () => {
    // A legacy entry for session 'other' must not be stripped when repairing
    // session 'sess' — different ownership.
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command:
                    "'reder-hook' --session-id 'other' --socket '/tmp/reder.sock' " +
                    "--token 'rdr_sess_other_secret' --hook UserPromptSubmit",
                },
              ],
            },
          ],
        },
      }),
    );
    installClaudeHooks(params());
    const doc = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(doc.hooks.UserPromptSubmit).toHaveLength(2);
  });

  it('writes settings.local.json with 0600 permissions', () => {
    installClaudeHooks(params());
    const mode = statSync(settingsPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('removeClaudeHooks', () => {
  it('strips only reder-tagged entries, leaving user hooks intact', () => {
    installClaudeHooks(params());
    const doc = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    (doc.hooks.UserPromptSubmit as unknown[]).push({
      matcher: '*',
      hooks: [{ type: 'command', command: 'echo user-hook' }],
    });
    writeFileSync(settingsPath(), JSON.stringify(doc));

    removeClaudeHooks({ projectDir: dir, sessionId: 'sess' });
    const after = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    expect((after.hooks.UserPromptSubmit as unknown[]).length).toBe(1);
  });

  it('deletes the file entirely when nothing is left', () => {
    installClaudeHooks(params());
    removeClaudeHooks({ projectDir: dir, sessionId: 'sess' });
    expect(existsSync(settingsPath())).toBe(false);
  });

  it('is a no-op when the file does not exist', () => {
    expect(() => removeClaudeHooks({ projectDir: dir, sessionId: 'sess' })).not.toThrow();
  });
});

describe('hasClaudeHooks', () => {
  it('returns true after install, false after remove', () => {
    expect(hasClaudeHooks({ projectDir: dir, sessionId: 'sess' })).toBe(false);
    installClaudeHooks(params());
    expect(hasClaudeHooks({ projectDir: dir, sessionId: 'sess' })).toBe(true);
    removeClaudeHooks({ projectDir: dir, sessionId: 'sess' });
    expect(hasClaudeHooks({ projectDir: dir, sessionId: 'sess' })).toBe(false);
  });
});
