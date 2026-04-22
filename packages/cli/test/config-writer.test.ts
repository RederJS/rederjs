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
    });
    expect(peekSession({ configPath, sessionId: 'x' })).toEqual({
      session_id: 'x',
      display_name: 'X',
      workspace_dir: '/tmp/x',
      auto_start: true,
    });
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
    });
    expect(r.kind).toBe('created');
    const peeked = peekSession({ configPath, sessionId: 's1' });
    expect(peeked).toEqual({
      session_id: 's1',
      display_name: 'S1',
      workspace_dir: '/tmp/s1',
      auto_start: false,
    });
  });

  it('is a no-op when all fields match', () => {
    upsertSession({
      configPath,
      sessionId: 's1',
      displayName: 'S1',
      workspaceDir: '/tmp/s1',
      autoStart: false,
    });
    const r = upsertSession({
      configPath,
      sessionId: 's1',
      displayName: 'S1',
      workspaceDir: '/tmp/s1',
      autoStart: false,
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
    });
    const r = upsertSession({
      configPath,
      sessionId: 's1',
      displayName: 'S1',
      workspaceDir: '/tmp/new',
      autoStart: false,
    });
    expect(r).toEqual({ kind: 'updated_workspace_dir', previous: '/tmp/old' });
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
    });
    expect(r).toEqual({ kind: 'updated_workspace_dir', previous: undefined });
    const p = peekSession({ configPath, sessionId: 'legacy' });
    expect(p?.workspace_dir).toBe('/tmp/legacy');
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
