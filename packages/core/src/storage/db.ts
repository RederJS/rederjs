import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database, { type Database as Db } from 'better-sqlite3';

export interface DatabaseHandle {
  readonly raw: Db;
  close(): void;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface OpenDatabaseOptions {
  migrationsDir?: string;
  readonly?: boolean;
}

function runSql(db: Db, sql: string): void {
  // eslint-disable-next-line no-useless-call
  db.exec.call(db, sql);
}

export function openDatabase(path: string, opts: OpenDatabaseOptions = {}): DatabaseHandle {
  const raw = new Database(path, { readonly: opts.readonly ?? false });
  raw.pragma('journal_mode = WAL');
  raw.pragma('synchronous = NORMAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');

  ensureMigrationsTable(raw);
  applyMigrations(raw, opts.migrationsDir ?? MIGRATIONS_DIR);

  return {
    raw,
    close() {
      raw.close();
    },
  };
}

function ensureMigrationsTable(db: Db): void {
  runSql(
    db,
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
  );
}

function applyMigrations(db: Db, dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
  );

  for (const file of files) {
    const match = /^(\d+)_/.exec(file);
    if (!match || match[1] === undefined) {
      throw new Error(`Migration filename must start with NNN_: ${file}`);
    }
    const version = Number(match[1]);
    if (applied.has(version)) continue;

    const sql = readFileSync(join(dir, file), 'utf8');
    const tx = db.transaction(() => {
      runSql(db, sql);
      record.run(version, new Date().toISOString());
    });
    tx();
  }
}
