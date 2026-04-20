import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DatabaseHandle } from '../../src/storage/db.js';

let tmpDir: string;
let db: DatabaseHandle | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'reder-db-test-'));
});

afterEach(() => {
  db?.close();
  db = null;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('storage/db', () => {
  it('opens a fresh database with WAL mode', () => {
    const path = join(tmpDir, 'test.db');
    db = openDatabase(path);
    const mode = db.raw.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
  });

  it('enables foreign keys', () => {
    db = openDatabase(join(tmpDir, 'test.db'));
    const fk = db.raw.pragma('foreign_keys', { simple: true });
    expect(Number(fk)).toBe(1);
  });

  it('runs migrations on first open', () => {
    db = openDatabase(join(tmpDir, 'test.db'));
    const tables = db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('sessions');
    expect(names).toContain('bindings');
    expect(names).toContain('inbound_messages');
    expect(names).toContain('outbound_messages');
    expect(names).toContain('permission_requests');
    expect(names).toContain('persistent_approvals');
    expect(names).toContain('adapter_kv');
    expect(names).toContain('schema_migrations');
  });

  it('records applied migration version', () => {
    db = openDatabase(join(tmpDir, 'test.db'));
    const row = db.raw
      .prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined;
    expect(row?.version).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent across re-opens', () => {
    const path = join(tmpDir, 'test.db');
    db = openDatabase(path);
    const initialCount = (
      db.raw.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }
    ).c;
    db.close();
    db = openDatabase(path);
    const rows = db.raw.prepare('SELECT version FROM schema_migrations').all() as Array<{
      version: number;
    }>;
    expect(rows).toHaveLength(initialCount);
  });

  it('supports inserting + reading a session row', () => {
    db = openDatabase(join(tmpDir, 'test.db'));
    db.raw
      .prepare(
        `INSERT INTO sessions (session_id, display_name, shim_token_hash, created_at, state)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('booknerds', 'BookNerds', 'hash', '2026-04-20T00:00:00Z', 'registered');
    const row = db.raw.prepare('SELECT * FROM sessions WHERE session_id = ?').get('booknerds');
    expect(row).toMatchObject({ session_id: 'booknerds', display_name: 'BookNerds' });
  });
});
