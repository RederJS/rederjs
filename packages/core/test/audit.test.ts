import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditLog, type AuditLog } from '../src/audit.js';

let dir: string;
let audit: AuditLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-audit-test-'));
  audit = createAuditLog(dir);
});

afterEach(() => {
  audit.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('audit log', () => {
  it('appends JSON lines to audit-YYYY-MM-DD.log in runtime dir', () => {
    audit.write({
      kind: 'pair',
      session_id: 'booknerds',
      adapter: 'telegram',
      sender_id: '12345',
    });
    const files = readdirSync(dir).filter((f) => f.startsWith('audit-'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^audit-\d{4}-\d{2}-\d{2}\.log$/);
    const text = readFileSync(join(dir, files[0]!), 'utf8');
    const parsed = JSON.parse(text.trim());
    expect(parsed).toMatchObject({
      kind: 'pair',
      session_id: 'booknerds',
      adapter: 'telegram',
      sender_id: '12345',
    });
    expect(parsed.timestamp).toBeTruthy();
  });

  it('file is chmod 0600', () => {
    audit.write({ kind: 'config_change', detail: 'reload' });
    const files = readdirSync(dir).filter((f) => f.startsWith('audit-'));
    const mode = statSync(join(dir, files[0]!)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('appends multiple events as separate JSON lines', () => {
    audit.write({ kind: 'pair', session_id: 'a', adapter: 't', sender_id: '1' });
    audit.write({ kind: 'unpair', session_id: 'a', adapter: 't', sender_id: '1' });
    audit.write({ kind: 'adapter_start', adapter: 'telegram' });
    const files = readdirSync(dir).filter((f) => f.startsWith('audit-'));
    const text = readFileSync(join(dir, files[0]!), 'utf8');
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('rolls to a new file on day change', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T23:59:00Z'));
    audit.write({ kind: 'adapter_start', adapter: 'x' });
    vi.setSystemTime(new Date('2026-04-21T00:00:30Z'));
    audit.write({ kind: 'adapter_stop', adapter: 'x' });
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('audit-'))
      .sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toContain('2026-04-20');
    expect(files[1]).toContain('2026-04-21');
  });
});
