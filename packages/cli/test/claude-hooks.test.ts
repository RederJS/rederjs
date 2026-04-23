import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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
    token: 'rdr_sess_token',
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

  it('updates the command path on re-install with new token', () => {
    installClaudeHooks(params({ token: 'rdr_sess_old' }));
    installClaudeHooks(params({ token: 'rdr_sess_new' }));
    const doc = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      hooks: Record<
        string,
        Array<{ hooks: Array<{ command: string }> }>
      >;
    };
    expect(doc.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toContain('rdr_sess_new');
    expect(doc.hooks.UserPromptSubmit[0]!.hooks[0]!.command).not.toContain('rdr_sess_old');
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
