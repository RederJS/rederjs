import type { Database as Db } from 'better-sqlite3';
import type { AdapterStorage } from '../adapter.js';

/**
 * Returns an AdapterStorage implementation scoped to a single adapter namespace
 * backed by the adapter_kv table. Adapters cannot read or list keys from other
 * namespaces (enforced by always filtering WHERE adapter = ?).
 */
export function createAdapterStorage(db: Db, adapter: string): AdapterStorage {
  return {
    async get(key: string): Promise<Buffer | null> {
      const row = db
        .prepare('SELECT value FROM adapter_kv WHERE adapter = ? AND key = ?')
        .get(adapter, key) as { value: Buffer } | undefined;
      return row?.value ?? null;
    },
    async set(key: string, value: Buffer | string): Promise<void> {
      const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
      db.prepare(
        `INSERT INTO adapter_kv (adapter, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(adapter, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(adapter, key, buf, new Date().toISOString());
    },
    async delete(key: string): Promise<void> {
      db.prepare('DELETE FROM adapter_kv WHERE adapter = ? AND key = ?').run(adapter, key);
    },
    async list(prefix?: string): Promise<string[]> {
      if (prefix) {
        const rows = db
          .prepare('SELECT key FROM adapter_kv WHERE adapter = ? AND key LIKE ? ORDER BY key')
          .all(adapter, `${prefix}%`) as Array<{ key: string }>;
        return rows.map((r) => r.key);
      }
      const rows = db
        .prepare('SELECT key FROM adapter_kv WHERE adapter = ? ORDER BY key')
        .all(adapter) as Array<{ key: string }>;
      return rows.map((r) => r.key);
    },
  };
}
