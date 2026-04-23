import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scaffoldConfig,
  readWebAdapterConfig,
  updateWebAdapterConfig,
  peekSession,
  upsertSession,
  removeSession,
  upsertTelegramBot,
  removeTelegramBot,
  listTelegramBots,
  getTelegramMode,
  setTelegramMode,
  listTelegramAllowlistUsers,
  addTelegramAllowlistUser,
  removeTelegramAllowlistUser,
} from '../src/commands/config-writer.js';

let dir: string;
let configPath: string;
let envPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-cli-cw-test-'));
  configPath = join(dir, 'reder.config.yaml');
  envPath = join(dir, 'reder.env');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('scaffoldConfig', () => {
  it('creates config + env with mode 0600, web adapter populated', () => {
    const r = scaffoldConfig({ configPath, envPath, webBind: '100.64.0.5', webPort: 7890 });
    expect(r.created).toBe(true);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('bind: 100.64.0.5');
    expect(text).toContain('port: 7890');
    expect(text).toContain("module: '@rederjs/adapter-web'");
    expect(text).toContain('sessions: []');
  });

  it('is a no-op when config already exists', () => {
    writeFileSync(configPath, '# existing\nversion: 1\n', { mode: 0o600 });
    const r = scaffoldConfig({ configPath, envPath, webBind: '127.0.0.1', webPort: 7781 });
    expect(r.created).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe('# existing\nversion: 1\n');
  });
});

describe('readWebAdapterConfig', () => {
  it('returns undefined when config missing', () => {
    expect(readWebAdapterConfig(configPath)).toBeUndefined();
  });

  it('round-trips what scaffoldConfig wrote', () => {
    scaffoldConfig({ configPath, envPath, webBind: '10.0.0.1', webPort: 9000 });
    expect(readWebAdapterConfig(configPath)).toEqual({ bind: '10.0.0.1', port: 9000 });
  });

  it('returns undefined if web adapter is not configured', () => {
    writeFileSync(configPath, 'version: 1\nsessions: []\nadapters: {}\n');
    expect(readWebAdapterConfig(configPath)).toBeUndefined();
  });
});

describe('updateWebAdapterConfig', () => {
  it('updates bind + port, preserving other fields and comments', () => {
    writeFileSync(
      configPath,
      `version: 1

# daemon logging preferences
logging:
  level: debug  # verbose for now

health:
  enabled: true
  bind: 127.0.0.1
  port: 7781

sessions:
  - session_id: existing
    display_name: Existing
    workspace_dir: /tmp/existing
    auto_start: true

adapters:
  web:
    module: '@rederjs/adapter-web'
    enabled: true
    config:
      bind: 127.0.0.1
      port: 7781
`,
    );
    updateWebAdapterConfig({ configPath, bind: '100.1.2.3', port: 8000 });
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('bind: 100.1.2.3');
    expect(text).toContain('port: 8000');
    expect(text).toContain('# daemon logging preferences');
    expect(text).toContain('# verbose for now');
    expect(text).toContain('session_id: existing');
    expect(text).toContain('auto_start: true');
  });

  it('creates the web adapter block if absent', () => {
    writeFileSync(configPath, 'version: 1\nsessions: []\nadapters: {}\n');
    updateWebAdapterConfig({ configPath, bind: '1.2.3.4', port: 4321 });
    const snap = readWebAdapterConfig(configPath);
    expect(snap).toEqual({ bind: '1.2.3.4', port: 4321 });
  });
});

describe('peekSession', () => {
  beforeEach(() => {
    scaffoldConfig({ configPath, envPath, webBind: '127.0.0.1', webPort: 7781 });
  });

  it('returns undefined when session not present', () => {
    expect(peekSession({ configPath, sessionId: 'ghost' })).toBeUndefined();
  });

  it('returns the session when present', () => {
    upsertSession({
      configPath,
      sessionId: 'x',
      displayName: 'X',
      workspaceDir: '/tmp/x',
      autoStart: true,
      permissionMode: 'default',
    });
    expect(peekSession({ configPath, sessionId: 'x' })).toEqual({
      session_id: 'x',
      display_name: 'X',
      workspace_dir: '/tmp/x',
      auto_start: true,
      permission_mode: 'default',
    });
  });

  it('coerces unknown permission_mode in YAML back to default', () => {
    writeFileSync(
      configPath,
      `version: 1
runtime: { runtime_dir: ${join(dir, 'rt')}, data_dir: ${join(dir, 'data')} }
sessions:
  - session_id: legacy
    display_name: Legacy
    workspace_dir: /tmp/legacy
    auto_start: false
    permission_mode: bogus
adapters: {}
`,
    );
    const p = peekSession({ configPath, sessionId: 'legacy' });
    expect(p?.permission_mode).toBe('default');
  });
});

describe('upsertSession', () => {
  beforeEach(() => {
    scaffoldConfig({ configPath, envPath, webBind: '127.0.0.1', webPort: 7781 });
  });

  it('adds a new session entry and reports created', () => {
    const r = upsertSession({
      configPath,
      sessionId: 's1',
      displayName: 'S1',
      workspaceDir: '/tmp/s1',
      autoStart: false,
      permissionMode: 'default',
    });
    expect(r.kind).toBe('created');
    const peeked = peekSession({ configPath, sessionId: 's1' });
    expect(peeked).toEqual({
      session_id: 's1',
      display_name: 'S1',
      workspace_dir: '/tmp/s1',
      auto_start: false,
      permission_mode: 'default',
    });
  });

  it('persists a non-default permission_mode to YAML', () => {
    upsertSession({
      configPath,
      sessionId: 'planner',
      displayName: 'Planner',
      workspaceDir: '/tmp/p',
      autoStart: false,
      permissionMode: 'plan',
    });
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('permission_mode: plan');
    expect(peekSession({ configPath, sessionId: 'planner' })?.permission_mode).toBe('plan');
  });

  it('is a no-op when all fields match', () => {
    upsertSession({
      configPath,
      sessionId: 's1',
      displayName: 'S1',
      workspaceDir: '/tmp/s1',
      autoStart: false,
      permissionMode: 'default',
    });
    const r = upsertSession({
      configPath,
      sessionId: 's1',
      displayName: 'S1',
      workspaceDir: '/tmp/s1',
      autoStart: false,
      permissionMode: 'default',
    });
    expect(r.kind).toBe('updated_same');
  });

  it('updates workspace_dir and reports previous', () => {
    upsertSession({
      configPath,
      sessionId: 's1',
      displayName: 'S1',
      workspaceDir: '/tmp/old',
      autoStart: false,
      permissionMode: 'default',
    });
    const r = upsertSession({
      configPath,
      sessionId: 's1',
      displayName: 'S1',
      workspaceDir: '/tmp/new',
      autoStart: false,
      permissionMode: 'default',
    });
    expect(r).toEqual({ kind: 'updated_workspace_dir', previous: '/tmp/old' });
  });

  it('updates permission_mode and reports previous', () => {
    upsertSession({
      configPath,
      sessionId: 's1',
      displayName: 'S1',
      workspaceDir: '/tmp/s1',
      autoStart: false,
      permissionMode: 'default',
    });
    const r = upsertSession({
      configPath,
      sessionId: 's1',
      displayName: 'S1',
      workspaceDir: '/tmp/s1',
      autoStart: false,
      permissionMode: 'bypassPermissions',
    });
    expect(r).toEqual({ kind: 'updated_permission_mode', previous: 'default' });
  });

  it('migrates an old entry missing workspace_dir', () => {
    writeFileSync(
      configPath,
      `version: 1
runtime:
  runtime_dir: ${join(dir, 'runtime')}
  data_dir: ${join(dir, 'data')}
sessions:
  - session_id: legacy
    display_name: Legacy
adapters: {}
`,
    );
    const r = upsertSession({
      configPath,
      sessionId: 'legacy',
      displayName: 'Legacy',
      workspaceDir: '/tmp/legacy',
      autoStart: false,
      permissionMode: 'default',
    });
    expect(r).toEqual({ kind: 'updated_workspace_dir', previous: undefined });
    const p = peekSession({ configPath, sessionId: 'legacy' });
    expect(p?.workspace_dir).toBe('/tmp/legacy');
    expect(p?.permission_mode).toBe('default');
  });

  it('preserves unrelated comments when updating sessions', () => {
    writeFileSync(
      configPath,
      `version: 1

# top-level comment about logging
logging:
  level: info
sessions: []
adapters: {}
`,
    );
    upsertSession({
      configPath,
      sessionId: 's1',
      displayName: 'S1',
      workspaceDir: '/tmp/s1',
      autoStart: false,
      permissionMode: 'default',
    });
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('# top-level comment about logging');
    expect(text).toContain('session_id: s1');
  });
});

describe('removeSession', () => {
  beforeEach(() => {
    scaffoldConfig({ configPath, envPath, webBind: '127.0.0.1', webPort: 7781 });
  });

  it('removes a matching session', () => {
    upsertSession({
      configPath,
      sessionId: 'gone',
      displayName: 'Gone',
      workspaceDir: '/tmp/gone',
      autoStart: false,
    });
    upsertSession({
      configPath,
      sessionId: 'stays',
      displayName: 'Stays',
      workspaceDir: '/tmp/stays',
      autoStart: false,
    });
    const r = removeSession({ configPath, sessionId: 'gone' });
    expect(r.removed).toBe(true);
    expect(peekSession({ configPath, sessionId: 'gone' })).toBeUndefined();
    expect(peekSession({ configPath, sessionId: 'stays' })).toBeTruthy();
  });

  it('reports removed:false when absent', () => {
    expect(removeSession({ configPath, sessionId: 'ghost' })).toEqual({ removed: false });
  });
});

describe('envPath behavior', () => {
  it('does not clobber an existing env file', () => {
    writeFileSync(envPath, 'EXISTING=yes\n', { mode: 0o600 });
    scaffoldConfig({ configPath, envPath, webBind: '127.0.0.1', webPort: 7781 });
    expect(readFileSync(envPath, 'utf8')).toBe('EXISTING=yes\n');
  });

  it(existsSync('/nonexistent') ? 'skip' : 'writes env when absent', () => {
    scaffoldConfig({ configPath, envPath, webBind: '127.0.0.1', webPort: 7781 });
    expect(existsSync(envPath)).toBe(true);
  });
});

describe('upsertTelegramBot', () => {
  beforeEach(() => {
    scaffoldConfig({ configPath, envPath, webBind: '127.0.0.1', webPort: 7781 });
  });

  it('creates the adapters.telegram block and adds the first bot (inline token)', () => {
    const r = upsertTelegramBot({
      configPath,
      sessionId: 'reder',
      token: 'abc:123',
    });
    expect(r.created).toBe(true);
    const text = readFileSync(configPath, 'utf8');
    expect(text).toMatch(/module: ['"]@rederjs\/adapter-telegram['"]/);
    expect(text).toContain('session_id: reder');
    expect(text).toContain('token: abc:123');
    expect(text).not.toContain('token_env:');
  });

  it('supports token_env for externally-set env vars', () => {
    upsertTelegramBot({ configPath, sessionId: 'reder', tokenEnv: 'MY_EXTERNAL_VAR' });
    const bots = listTelegramBots({ configPath });
    expect(bots).toEqual([{ session_id: 'reder', token_env: 'MY_EXTERNAL_VAR' }]);
  });

  it('is idempotent on repeated upsert with same fields', () => {
    upsertTelegramBot({ configPath, sessionId: 'reder', token: 'abc:123' });
    const r = upsertTelegramBot({
      configPath,
      sessionId: 'reder',
      token: 'abc:123',
    });
    expect(r.created).toBe(false);
    const bots = listTelegramBots({ configPath });
    expect(bots).toEqual([{ session_id: 'reder', token: 'abc:123' }]);
  });

  it('switches token_env → token cleanly (no stale token_env field)', () => {
    upsertTelegramBot({ configPath, sessionId: 'reder', tokenEnv: 'MY_VAR' });
    upsertTelegramBot({ configPath, sessionId: 'reder', token: 'inline-token-xyz' });
    const bots = listTelegramBots({ configPath });
    expect(bots).toEqual([{ session_id: 'reder', token: 'inline-token-xyz' }]);
  });

  it('rejects an upsert that has neither token nor tokenEnv', () => {
    expect(() =>
      upsertTelegramBot({ configPath, sessionId: 'reder' } as unknown as {
        configPath: string;
        sessionId: string;
      }),
    ).toThrow(/either tokenEnv or token/);
  });
});

describe('removeTelegramBot', () => {
  beforeEach(() => {
    scaffoldConfig({ configPath, envPath, webBind: '127.0.0.1', webPort: 7781 });
  });

  it('removes a configured bot and reports removed:true', () => {
    upsertTelegramBot({ configPath, sessionId: 'reder', token: 'a:1' });
    upsertTelegramBot({ configPath, sessionId: 'stays', token: 'b:2' });
    const r = removeTelegramBot({ configPath, sessionId: 'reder' });
    expect(r.removed).toBe(true);
    const bots = listTelegramBots({ configPath });
    expect(bots).toEqual([{ session_id: 'stays', token: 'b:2' }]);
  });

  it('reports removed:false when the session has no bot', () => {
    expect(removeTelegramBot({ configPath, sessionId: 'ghost' })).toEqual({ removed: false });
  });
});

describe('telegram mode get/set', () => {
  beforeEach(() => {
    scaffoldConfig({ configPath, envPath, webBind: '127.0.0.1', webPort: 7781 });
  });

  it('defaults to pairing when no mode is set', () => {
    expect(getTelegramMode({ configPath })).toBe('pairing');
  });

  it('round-trips via set', () => {
    setTelegramMode({ configPath, mode: 'allowlist' });
    expect(getTelegramMode({ configPath })).toBe('allowlist');
    setTelegramMode({ configPath, mode: 'pairing' });
    expect(getTelegramMode({ configPath })).toBe('pairing');
  });
});

describe('telegram allowlist', () => {
  beforeEach(() => {
    scaffoldConfig({ configPath, envPath, webBind: '127.0.0.1', webPort: 7781 });
  });

  it('add + list + remove', () => {
    expect(listTelegramAllowlistUsers({ configPath })).toEqual([]);
    expect(addTelegramAllowlistUser({ configPath, userId: '123' })).toEqual({ added: true });
    expect(addTelegramAllowlistUser({ configPath, userId: '456' })).toEqual({ added: true });
    expect(listTelegramAllowlistUsers({ configPath })).toEqual(['123', '456']);
    expect(addTelegramAllowlistUser({ configPath, userId: '123' })).toEqual({ added: false });
    expect(removeTelegramAllowlistUser({ configPath, userId: '123' })).toEqual({ removed: true });
    expect(removeTelegramAllowlistUser({ configPath, userId: 'absent' })).toEqual({
      removed: false,
    });
    expect(listTelegramAllowlistUsers({ configPath })).toEqual(['456']);
  });

  it('rejects non-numeric user ids', () => {
    expect(() => addTelegramAllowlistUser({ configPath, userId: '@alice' })).toThrow(
      /numeric Telegram user_id/,
    );
  });
});
