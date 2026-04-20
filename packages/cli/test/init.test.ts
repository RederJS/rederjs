import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../src/commands/init.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-cli-init-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runInit', () => {
  it('writes a new config and env file with mode 0600', () => {
    const result = runInit({
      configPath: join(dir, 'c.yaml'),
      envPath: join(dir, 'e.env'),
      sessionId: 'booknerds',
      displayName: 'BookNerds',
      botToken: 'abc:123',
    });
    expect(existsSync(result.configPath)).toBe(true);
    expect(existsSync(result.envPath)).toBe(true);
    expect(statSync(result.configPath).mode & 0o777).toBe(0o600);
    expect(statSync(result.envPath).mode & 0o777).toBe(0o600);
    const envText = readFileSync(result.envPath, 'utf8');
    expect(envText).toContain('abc:123');
  });

  it('refuses to overwrite without --force', () => {
    const opts = { configPath: join(dir, 'c.yaml'), envPath: join(dir, 'e.env'), sessionId: 's' };
    runInit(opts);
    expect(() => runInit(opts)).toThrow(/already exists/);
  });

  it('overwrites with --force', () => {
    const opts = { configPath: join(dir, 'c.yaml'), envPath: join(dir, 'e.env'), sessionId: 's' };
    runInit(opts);
    expect(() => runInit({ ...opts, force: true })).not.toThrow();
  });

  it('computes a sensible default token env var name', () => {
    const result = runInit({
      configPath: join(dir, 'c.yaml'),
      envPath: join(dir, 'e.env'),
      sessionId: 'book-nerds',
    });
    expect(result.tokenEnvVar).toBe('TELEGRAM_BOT_BOOK_NERDS');
  });
});
