import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runSessionsList,
  runSessionStart,
  runSessionsUp,
  formatSessionsList,
} from '../src/commands/sessions.js';
import { runDashboardUrl, runDashboardRotateToken } from '../src/commands/dashboard.js';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import * as tmux from '@rederjs/core/tmux';

let dir: string;
let configPath: string;

function writeConfig(content: string): void {
  writeFileSync(configPath, content);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-cli-sessions-'));
  configPath = join(dir, 'reder.config.yaml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('reder sessions list', () => {
  it('lists configured sessions with tmux status', () => {
    vi.spyOn(tmux, 'listRunning').mockReturnValue(['reder']);
    writeConfig(`version: 1
runtime: { runtime_dir: ${dir}/rt, data_dir: ${dir}/data }
sessions:
  - session_id: reder
    display_name: Reder
    workspace_dir: ${dir}
    auto_start: true
  - session_id: mango
    display_name: Mango
    workspace_dir: ${dir}
`);
    const r = runSessionsList({ configPath });
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions[0]).toMatchObject({
      session_id: 'reder',
      tmux_running: true,
      auto_start: true,
    });
    expect(r.sessions[1]).toMatchObject({ session_id: 'mango', tmux_running: false });
  });

  it('detects orphan tmux sessions not in config', () => {
    vi.spyOn(tmux, 'listRunning').mockReturnValue(['reder', 'orphan1']);
    writeConfig(`version: 1
runtime: { runtime_dir: ${dir}/rt, data_dir: ${dir}/data }
sessions:
  - { session_id: reder, display_name: Reder }
`);
    const r = runSessionsList({ configPath });
    expect(r.orphan_tmux).toEqual(['orphan1']);
  });

  it('formats output as a readable table', () => {
    vi.spyOn(tmux, 'listRunning').mockReturnValue([]);
    writeConfig(`version: 1
runtime: { runtime_dir: ${dir}/rt, data_dir: ${dir}/data }
sessions:
  - { session_id: reder, display_name: Reder }
`);
    const r = runSessionsList({ configPath });
    const text = formatSessionsList(r);
    expect(text).toContain('ID');
    expect(text).toContain('reder');
  });
});

describe('reder sessions start', () => {
  it('refuses a session not in config', () => {
    writeConfig(`version: 1
runtime: { runtime_dir: ${dir}/rt, data_dir: ${dir}/data }
sessions: []
`);
    const r = runSessionStart({ sessionId: 'missing', configPath });
    expect(r.started).toBe(false);
    expect(r.reason).toBe('not_in_config');
  });

  it('refuses a session without workspace_dir', () => {
    writeConfig(`version: 1
runtime: { runtime_dir: ${dir}/rt, data_dir: ${dir}/data }
sessions:
  - { session_id: reder, display_name: Reder }
`);
    const r = runSessionStart({ sessionId: 'reder', configPath });
    expect(r.started).toBe(false);
    expect(r.reason).toBe('no_workspace_dir');
  });

  it('calls tmux.startSession when all preconditions hold', () => {
    const ws = join(dir, 'ws');
    mkdirSync(ws);
    const spy = vi.spyOn(tmux, 'startSession').mockReturnValue({ started: true });
    writeConfig(`version: 1
runtime: { runtime_dir: ${dir}/rt, data_dir: ${dir}/data }
sessions:
  - session_id: reder
    display_name: Reder
    workspace_dir: ${ws}
`);
    const r = runSessionStart({ sessionId: 'reder', configPath });
    expect(r.started).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'reder',
        workspace_dir: ws,
        permission_mode: 'default',
      }),
    );
  });

  it('passes the configured permission_mode through to tmux.startSession', () => {
    const ws = join(dir, 'ws');
    mkdirSync(ws);
    const spy = vi.spyOn(tmux, 'startSession').mockReturnValue({ started: true });
    writeConfig(`version: 1
runtime: { runtime_dir: ${dir}/rt, data_dir: ${dir}/data }
sessions:
  - session_id: reder
    display_name: Reder
    workspace_dir: ${ws}
    permission_mode: plan
`);
    runSessionStart({ sessionId: 'reder', configPath });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ permission_mode: 'plan' }));
  });
});

describe('reder sessions up', () => {
  it('skips sessions without workspace_dir', () => {
    const ws = join(dir, 'ws');
    mkdirSync(ws);
    vi.spyOn(tmux, 'startSession').mockReturnValue({ started: true });
    writeConfig(`version: 1
runtime: { runtime_dir: ${dir}/rt, data_dir: ${dir}/data }
sessions:
  - session_id: reder
    display_name: Reder
    workspace_dir: ${ws}
  - session_id: nowhere
    display_name: Nowhere
`);
    const r = runSessionsUp({ configPath });
    expect(r.results).toHaveLength(1);
    expect(r.results[0]?.session_id).toBe('reder');
  });
});

describe('reder dashboard url', () => {
  it('errors when web adapter is not enabled', () => {
    writeConfig(`version: 1
runtime: { runtime_dir: ${dir}/rt, data_dir: ${dir}/data }
sessions: []
`);
    expect(() => runDashboardUrl({ configPath })).toThrow(/not enabled/);
  });

  it('builds a token URL from the persisted token file', () => {
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'dashboard.token'), 'abc123\n');
    writeConfig(`version: 1
runtime: { runtime_dir: ${dir}/rt, data_dir: ${dataDir} }
sessions: []
adapters:
  web:
    module: '@rederjs/adapter-web'
    enabled: true
    config: { bind: 127.0.0.1, port: 7781, auth: token }
`);
    const r = runDashboardUrl({ configPath });
    expect(r.url).toBe('http://127.0.0.1:7781/?token=abc123');
    expect(r.auth).toBe('token');
  });

  it('returns a no-auth URL when auth=none', () => {
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeConfig(`version: 1
runtime: { runtime_dir: ${dir}/rt, data_dir: ${dataDir} }
sessions: []
adapters:
  web:
    module: '@rederjs/adapter-web'
    enabled: true
    config: { bind: 127.0.0.1, port: 7781, auth: none }
`);
    const r = runDashboardUrl({ configPath });
    expect(r.url).toBe('http://127.0.0.1:7781/');
    expect(r.auth).toBe('none');
  });

  it('marks legacy raw-token files explicitly', () => {
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'dashboard.token'), 'rdr_web_legacy_raw\n');
    writeConfig(`version: 1
runtime: { runtime_dir: ${dir}/rt, data_dir: ${dataDir} }
sessions: []
adapters:
  web:
    module: '@rederjs/adapter-web'
    enabled: true
    config: { bind: 127.0.0.1, port: 7781, auth: token }
`);
    const r = runDashboardUrl({ configPath });
    expect(r.legacy_token_format).toBe(true);
    expect(r.url).toContain('rdr_web_legacy_raw');
  });

  it('errors with rotate guidance when the token file is hashed', () => {
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    const hashHex = createHash('sha256').update('whatever').digest('hex');
    writeFileSync(join(dataDir, 'dashboard.token'), hashHex + '\n');
    writeConfig(`version: 1
runtime: { runtime_dir: ${dir}/rt, data_dir: ${dataDir} }
sessions: []
adapters:
  web:
    module: '@rederjs/adapter-web'
    enabled: true
    config: { bind: 127.0.0.1, port: 7781, auth: token }
`);
    expect(() => runDashboardUrl({ configPath })).toThrow(/rotate-token/);
  });
});

describe('reder dashboard rotate-token', () => {
  it('mints a new token, writes the hash, and returns the URL', () => {
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeConfig(`version: 1
runtime: { runtime_dir: ${dir}/rt, data_dir: ${dataDir} }
sessions: []
adapters:
  web:
    module: '@rederjs/adapter-web'
    enabled: true
    config: { bind: 127.0.0.1, port: 7781, auth: token }
`);
    const r = runDashboardRotateToken({ configPath });
    expect(r.rotated).toBe(false);
    expect(r.url).toMatch(/\?token=rdr_web_/);
    // On disk: hash, not raw.
    const onDisk = readFileSync(r.token_path, 'utf8').trim();
    expect(onDisk).toMatch(/^[0-9a-f]{64}$/);
    const rawTokenMatch = /\?token=([^&]+)/.exec(r.url);
    expect(rawTokenMatch).toBeTruthy();
    const raw = decodeURIComponent(rawTokenMatch![1]!);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(onDisk);
  });

  it('replaces an existing token and reports rotated=true', () => {
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'dashboard.token'), 'rdr_web_legacy\n');
    writeConfig(`version: 1
runtime: { runtime_dir: ${dir}/rt, data_dir: ${dataDir} }
sessions: []
adapters:
  web:
    module: '@rederjs/adapter-web'
    enabled: true
    config: { bind: 127.0.0.1, port: 7781, auth: token }
`);
    const r = runDashboardRotateToken({ configPath });
    expect(r.rotated).toBe(true);
    expect(existsSync(r.token_path)).toBe(true);
    const onDisk = readFileSync(r.token_path, 'utf8').trim();
    expect(onDisk).not.toBe('rdr_web_legacy');
    expect(onDisk).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses to rotate when auth: none', () => {
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeConfig(`version: 1
runtime: { runtime_dir: ${dir}/rt, data_dir: ${dataDir} }
sessions: []
adapters:
  web:
    module: '@rederjs/adapter-web'
    enabled: true
    config: { bind: 127.0.0.1, port: 7781, auth: none }
`);
    expect(() => runDashboardRotateToken({ configPath })).toThrow(/Cannot rotate/);
  });
});
