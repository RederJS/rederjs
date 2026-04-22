import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.js';

let dir: string;
let configPath: string;
let envPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-cli-init-test-'));
  configPath = join(dir, 'reder.config.yaml');
  envPath = join(dir, 'reder.env');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runInit', () => {
  it('creates fresh config + env with mode 0600 and the given web adapter settings', () => {
    const r = runInit({ configPath, envPath, webBind: '100.64.0.5', webPort: 7890 });
    expect(r.created).toBe(true);
    expect(r.updated).toBe(false);
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(envPath)).toBe(true);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('bind: 100.64.0.5');
    expect(text).toContain('port: 7890');
    expect(text).toContain('sessions: []');
    expect(text).not.toContain('session_id:');
  });

  it('is idempotent when values match', () => {
    runInit({ configPath, envPath, webBind: '127.0.0.1', webPort: 7781 });
    const r = runInit({ configPath, envPath, webBind: '127.0.0.1', webPort: 7781 });
    expect(r.created).toBe(false);
    expect(r.updated).toBe(false);
  });

  it('updates bind/port on re-run, preserving existing sessions and comments', () => {
    writeFileSync(
      configPath,
      `version: 1
# my notes
runtime:
  runtime_dir: ${join(dir, 'runtime')}
  data_dir: ${join(dir, 'data')}
sessions:
  - session_id: keep
    display_name: Keep
    workspace_dir: /tmp/keep
    auto_start: true
adapters:
  web:
    module: '@rederjs/adapter-web'
    enabled: true
    config:
      bind: 127.0.0.1
      port: 7781
`,
      { mode: 0o600 },
    );
    writeFileSync(envPath, 'EXISTING=1\n', { mode: 0o600 });
    const r = runInit({ configPath, envPath, webBind: '10.0.0.1', webPort: 8080 });
    expect(r.created).toBe(false);
    expect(r.updated).toBe(true);
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('bind: 10.0.0.1');
    expect(text).toContain('port: 8080');
    expect(text).toContain('# my notes');
    expect(text).toContain('session_id: keep');
    expect(readFileSync(envPath, 'utf8')).toBe('EXISTING=1\n');
  });
});
