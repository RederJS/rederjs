import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError } from '../src/config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'reder-config-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env['TEST_BOT_TOKEN'];
  delete process.env['TEST_OPENAI_KEY'];
});

function writeConfig(content: string): string {
  const path = join(tmpDir, 'reder.config.yaml');
  writeFileSync(path, content);
  return path;
}

describe('config loader', () => {
  it('parses a minimal valid config', () => {
    const path = writeConfig(`
version: 1
sessions:
  - session_id: booknerds
    display_name: BookNerds
`);
    const cfg = loadConfig(path);
    expect(cfg.version).toBe(1);
    expect(cfg.sessions).toHaveLength(1);
    expect(cfg.sessions[0]?.session_id).toBe('booknerds');
    expect(cfg.logging.level).toBe('info');
    expect(cfg.health.port).toBe(7781);
  });

  it('substitutes ${env:VAR} references', () => {
    process.env['TEST_BOT_TOKEN'] = '123:abc';
    const path = writeConfig(`
version: 1
adapters:
  telegram:
    module: '@rederjs/adapter-telegram'
    config:
      token: \${env:TEST_BOT_TOKEN}
`);
    const cfg = loadConfig(path);
    expect((cfg.adapters['telegram']?.config as { token: string }).token).toBe('123:abc');
  });

  it('substitutes ${file:path} references', () => {
    const secretPath = join(tmpDir, 'secret');
    writeFileSync(secretPath, 'filesecret-xyz\n');
    const path = writeConfig(`
version: 1
adapters:
  telegram:
    module: '@rederjs/adapter-telegram'
    config:
      token: \${file:${secretPath}}
`);
    const cfg = loadConfig(path);
    expect((cfg.adapters['telegram']?.config as { token: string }).token).toBe('filesecret-xyz');
  });

  it('rejects unknown top-level keys', () => {
    const path = writeConfig(`
version: 1
unknown_field: oops
`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('reports a named path on missing env var', () => {
    const path = writeConfig(`
version: 1
adapters:
  telegram:
    module: '@rederjs/adapter-telegram'
    config:
      token: \${env:MISSING_VAR_XYZ}
`);
    try {
      loadConfig(path);
      expect.unreachable('expected ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain('MISSING_VAR_XYZ');
    }
  });

  it('loads reder.env file if present alongside config', () => {
    writeFileSync(join(tmpDir, 'reder.env'), 'TEST_OPENAI_KEY=sk-abc\n');
    const path = writeConfig(`
version: 1
adapters:
  x:
    module: 'x'
    config:
      k: \${env:TEST_OPENAI_KEY}
`);
    const cfg = loadConfig(path);
    expect((cfg.adapters['x']?.config as { k: string }).k).toBe('sk-abc');
  });

  it('rejects invalid session_id format', () => {
    const path = writeConfig(`
version: 1
sessions:
  - session_id: "BadName With Spaces"
    display_name: X
`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('applies defaults for omitted fields', () => {
    const path = writeConfig(`version: 1\n`);
    const cfg = loadConfig(path);
    expect(cfg.security.rate_limit.per_sender_per_minute).toBe(60);
    expect(cfg.security.permission_default_on_timeout).toBe('deny');
    expect(cfg.security.permission_timeout_seconds).toBe(600);
    expect(cfg.storage.retention.inbound_acknowledged_days).toBe(7);
  });

  it('accepts an optional avatar field on a session', () => {
    const path = writeConfig(`
version: 1
sessions:
  - session_id: demo
    display_name: Demo
    avatar: ./images/demo.png
`);
    const cfg = loadConfig(path);
    expect(cfg.sessions[0]?.avatar).toBe('./images/demo.png');
  });

  it('omits avatar when not configured', () => {
    const path = writeConfig(`
version: 1
sessions:
  - session_id: demo
    display_name: Demo
`);
    const cfg = loadConfig(path);
    expect(cfg.sessions[0]?.avatar).toBeUndefined();
  });
});
