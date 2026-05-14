import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { openDatabase, type DatabaseHandle } from '../src/storage/db.js';
import { createSession } from '../src/sessions.js';
import { createLogger } from '../src/logger.js';
import { createAuditLog } from '../src/audit.js';
import { createIpcServer, type IpcServer } from '../src/ipc/server.js';
import { createRouter, type Router } from '../src/router.js';
import { encode, FrameDecoder } from '../src/ipc/codec.js';
import { createPairCode, lookupPairCode, redeemPairCode } from '../src/pairing.js';

describe('pairing storage', () => {
  let dir: string;
  let db: DatabaseHandle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reder-pairing-test-'));
    db = openDatabase(join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('createPairCode followed by lookupPairCode returns the binding metadata', () => {
    const rec = createPairCode(db.raw, {
      adapter: 'telegram',
      senderId: '42',
      senderMetadata: { chat_id: '42' },
    });
    const found = lookupPairCode(db.raw, rec.code);
    expect(found).not.toBeNull();
    expect(found?.adapter).toBe('telegram');
    expect(found?.senderId).toBe('42');
    expect(found?.senderMetadata).toEqual({ chat_id: '42' });
  });

  it('lookupPairCode returns null for an unknown code', () => {
    createPairCode(db.raw, { adapter: 'telegram', senderId: '42' });
    expect(lookupPairCode(db.raw, 'nopezz')).toBeNull();
  });

  it('reading the DB directly never reveals the plaintext code', () => {
    const rec = createPairCode(db.raw, { adapter: 'telegram', senderId: '42' });
    const rows = db.raw
      .prepare(
        `SELECT id, code_hash, salt, adapter, sender_id, sender_metadata,
                created_at, expires_at
           FROM pair_codes_v2`,
      )
      .all() as Array<{
      id: Buffer;
      code_hash: Buffer;
      salt: Buffer;
      adapter: string;
      sender_id: string;
      sender_metadata: string | null;
      created_at: string;
      expires_at: string;
    }>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Hash + salt are raw bytes; if the plaintext code somehow leaked into
    // either column we'd see it as a substring. It must not.
    const allBlobs = Buffer.concat([row.id, row.code_hash, row.salt]).toString('binary');
    expect(allBlobs.includes(rec.code)).toBe(false);
    // No column should hold the plaintext as text either.
    const allText = [
      row.adapter,
      row.sender_id,
      row.sender_metadata,
      row.created_at,
      row.expires_at,
    ]
      .filter((v): v is string => v !== null)
      .join('|');
    expect(allText.includes(rec.code)).toBe(false);
    // And there is no `code` column whatsoever.
    const cols = db.raw.prepare(`PRAGMA table_info(pair_codes_v2)`).all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).not.toContain('code');
  });

  it('expired codes are not redeemable', () => {
    const rec = createPairCode(db.raw, { adapter: 'telegram', senderId: '42' });
    // Force-expire by rewriting expires_at to the past.
    db.raw
      .prepare('UPDATE pair_codes_v2 SET expires_at = ?')
      .run(new Date(Date.now() - 60_000).toISOString());
    expect(lookupPairCode(db.raw, rec.code)).toBeNull();
    expect(redeemPairCode(db.raw, rec.code)).toBeNull();
  });

  it('redeemPairCode deletes the row from the DB on success', () => {
    const rec = createPairCode(db.raw, { adapter: 'telegram', senderId: '42' });
    const before = (
      db.raw.prepare('SELECT COUNT(*) AS c FROM pair_codes_v2').get() as { c: number }
    ).c;
    expect(before).toBe(1);

    const redeemed = redeemPairCode(db.raw, rec.code);
    expect(redeemed).not.toBeNull();
    expect(redeemed?.senderId).toBe('42');

    const after = (db.raw.prepare('SELECT COUNT(*) AS c FROM pair_codes_v2').get() as { c: number })
      .c;
    expect(after).toBe(0);
  });

  it('redeemPairCode is single-use: a second call with the same code returns null', () => {
    const rec = createPairCode(db.raw, { adapter: 'telegram', senderId: '42' });
    expect(redeemPairCode(db.raw, rec.code)).not.toBeNull();
    expect(redeemPairCode(db.raw, rec.code)).toBeNull();
  });
});

describe('admin_pair_request — atomic + rate-limited', () => {
  let dir: string;
  let db: DatabaseHandle;
  let ipcServer: IpcServer;
  let router: Router;
  let socketPath: string;
  let token: string;
  let token2: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'reder-pairing-router-test-'));
    db = openDatabase(join(dir, 'test.db'));
    socketPath = join(dir, 'reder.sock');
    const logger = createLogger({ level: 'error', destination: { write: () => {} } });
    const audit = createAuditLog(dir);
    ipcServer = await createIpcServer({
      db: db.raw,
      socketPath,
      logger,
      heartbeatTimeoutMs: 3000,
    });
    router = createRouter({ db: db.raw, ipcServer, logger, audit });
    const a = await createSession(db.raw, 'sess-a', 'Sess A');
    const b = await createSession(db.raw, 'sess-b', 'Sess B');
    token = a.token;
    token2 = b.token;
  });

  afterEach(async () => {
    await router.stop();
    await ipcServer.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('two concurrent admin_pair_requests with the same code: only one succeeds', async () => {
    const rec = createPairCode(db.raw, { adapter: 'telegram', senderId: '99' });

    const connA = await connect(socketPath);
    await authenticate(connA, 'sess-a', token);
    const connB = await connect(socketPath);
    await authenticate(connB, 'sess-b', token2);

    // Fire both redemptions without awaiting between writes so the daemon
    // sees them back-to-back.
    connA.socket.write(encode({ kind: 'admin_pair_request', code: rec.code }));
    connB.socket.write(encode({ kind: 'admin_pair_request', code: rec.code }));

    const resA = (await waitFor(
      connA,
      (m) => (m as { kind: string }).kind === 'admin_pair_result',
    )) as { success: boolean; error?: string };
    const resB = (await waitFor(
      connB,
      (m) => (m as { kind: string }).kind === 'admin_pair_result',
    )) as { success: boolean; error?: string };

    const successes = [resA, resB].filter((r) => r.success).length;
    expect(successes).toBe(1);

    // Exactly one binding row exists.
    const bindings = db.raw
      .prepare(`SELECT session_id FROM bindings WHERE adapter = 'telegram' AND sender_id = '99'`)
      .all() as Array<{ session_id: string }>;
    expect(bindings).toHaveLength(1);
    // The code row is gone either way (redeemed atomically).
    const remaining = (
      db.raw.prepare('SELECT COUNT(*) AS c FROM pair_codes_v2').get() as { c: number }
    ).c;
    expect(remaining).toBe(0);

    connA.socket.end();
    connB.socket.end();
  });

  it('rate-limits the 11th admin_pair_request within 60s for the same session', async () => {
    const conn = await connect(socketPath);
    await authenticate(conn, 'sess-a', token);

    // 10 attempts: each with a wrong code; each consumes a rate-limit slot
    // and returns success: false with an "expired/not found" error.
    for (let i = 0; i < 10; i++) {
      conn.socket.write(encode({ kind: 'admin_pair_request', code: `bogus${i % 10}` }));
    }
    const collected: Array<{ success: boolean; error?: string }> = [];
    while (collected.length < 10) {
      const r = (await waitForNext(
        conn,
        (m) => (m as { kind: string }).kind === 'admin_pair_result',
      )) as { success: boolean; error?: string };
      collected.push(r);
    }
    for (const r of collected) {
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/not found|expired/);
    }

    // The 11th must be rejected by the rate limiter, not by lookup.
    conn.socket.write(encode({ kind: 'admin_pair_request', code: 'eleven' }));
    const eleventh = (await waitForNext(
      conn,
      (m) => (m as { kind: string }).kind === 'admin_pair_result',
    )) as { success: boolean; error?: string };
    expect(eleventh.success).toBe(false);
    expect(eleventh.error).toMatch(/too many/i);

    conn.socket.end();
  });
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface TestConn {
  socket: Socket;
  decoder: FrameDecoder;
  received: unknown[];
  pending: Array<(msg: unknown) => boolean>;
}

function connect(path: string): Promise<TestConn> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    const conn: TestConn = { socket, decoder: new FrameDecoder(), received: [], pending: [] };
    socket.on('data', (chunk: Buffer) => {
      for (const frame of conn.decoder.push(chunk)) {
        conn.received.push(frame);
        for (let i = conn.pending.length - 1; i >= 0; i--) {
          if (conn.pending[i]!(frame)) conn.pending.splice(i, 1);
        }
      }
    });
    socket.once('connect', () => resolve(conn));
    socket.once('error', reject);
  });
}

async function authenticate(conn: TestConn, sessionId: string, tok: string): Promise<void> {
  conn.socket.write(
    encode({
      kind: 'hello',
      session_id: sessionId,
      shim_token: tok,
      shim_version: '0.1.0',
      claude_code_version: '2.1.81',
    }),
  );
  await waitFor(conn, (m) => (m as { kind: string }).kind === 'welcome');
}

/**
 * Resolve as soon as a frame matching `predicate` appears in `conn.received`.
 * Does NOT consume the frame — for tests that just check for the presence of
 * a one-shot event after the work that produces it.
 */
function waitFor(
  conn: TestConn,
  predicate: (msg: unknown) => boolean,
  timeoutMs: number = 2000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    for (const msg of conn.received) {
      if (predicate(msg)) return resolve(msg);
    }
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    conn.pending.push((msg) => {
      if (predicate(msg)) {
        clearTimeout(timer);
        resolve(msg);
        return true;
      }
      return false;
    });
  });
}

/**
 * Resolve with — and remove — the first matching frame from `conn.received`.
 * Use when waiting for one of a stream of identical-kind frames in order.
 */
function waitForNext(
  conn: TestConn,
  predicate: (msg: unknown) => boolean,
  timeoutMs: number = 2000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const idx = conn.received.findIndex(predicate);
    if (idx >= 0) {
      const [msg] = conn.received.splice(idx, 1);
      return resolve(msg);
    }
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    conn.pending.push((msg) => {
      if (predicate(msg)) {
        clearTimeout(timer);
        // Also remove from `conn.received` so the next `waitForNext` doesn't
        // re-match the same frame.
        const i = conn.received.lastIndexOf(msg);
        if (i >= 0) conn.received.splice(i, 1);
        resolve(msg);
        return true;
      }
      return false;
    });
  });
}
