import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquirePidLock, AlreadyRunningError } from '../src/lifecycle.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-lock-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pid lock', () => {
  it('creates the pid file with current pid', () => {
    const pidPath = join(dir, 'rederd.pid');
    const release = acquirePidLock(pidPath);
    expect(readFileSync(pidPath, 'utf8').trim()).toBe(String(process.pid));
    release();
    expect(existsSync(pidPath)).toBe(false);
  });

  it('second acquire on same pid file from within the same test process throws AlreadyRunningError', () => {
    const pidPath = join(dir, 'rederd.pid');
    const release = acquirePidLock(pidPath);
    expect(() => acquirePidLock(pidPath)).toThrow(AlreadyRunningError);
    release();
  });

  it('cleans up a stale lock whose pid no longer exists', () => {
    const pidPath = join(dir, 'rederd.pid');
    // Pick an extremely unlikely pid
    writeFileSync(pidPath, '99999999\n');
    const release = acquirePidLock(pidPath);
    expect(readFileSync(pidPath, 'utf8').trim()).toBe(String(process.pid));
    release();
  });
});
