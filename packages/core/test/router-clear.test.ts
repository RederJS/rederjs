import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { openDatabase, type DatabaseHandle } from '../src/storage/db.js';
import { createSession } from '../src/sessions.js';
import { createLogger } from '../src/logger.js';
import { createAuditLog } from '../src/audit.js';
import { createIpcServer, type IpcServer } from '../src/ipc/server.js';
import { createRouter, type Router } from '../src/router.js';
import { encode } from '../src/ipc/codec.js';
import { cacheInboundBlob, mediaDirFor } from '../src/media.js';
import type { SessionClearedPayload } from '../src/adapter.js';

let dir: string;
let db: DatabaseHandle;
let ipcServer: IpcServer;
let router: Router;
let socketPath: string;
let token: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-router-clear-'));
  db = openDatabase(join(dir, 'test.db'));
  socketPath = join(dir, 'reder.sock');
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  const audit = createAuditLog(dir);
  ipcServer = await createIpcServer({ db: db.raw, socketPath, logger });
  router = createRouter({
    db: db.raw,
    ipcServer,
    logger,
    audit,
    outboundInitialBackoffMs: 5,
    dataDir: dir,
  });
  const { token: t } = await createSession(db.raw, 'sess', 'Sess');
  token = t;
});

afterEach(async () => {
  await router.stop();
  await ipcServer.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function fireSessionStart(source: string | undefined): Socket {
  const sock = createConnection({ path: socketPath });
  const payload: { source?: string } = source !== undefined ? { source } : {};
  sock.once('connect', () => {
    sock.write(
      encode({
        kind: 'hook_event',
        session_id: 'sess',
        shim_token: token,
        hook: 'SessionStart',
        timestamp: new Date().toISOString(),
        payload,
      }),
    );
  });
  return sock;
}

async function waitForCleared(timeoutMs = 1500): Promise<SessionClearedPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timeout waiting for session.cleared')),
      timeoutMs,
    );
    router.events.on('session.cleared', (p) => {
      clearTimeout(timer);
      resolve(p);
    });
  });
}

async function expectNoCleared(ms: number): Promise<void> {
  let fired = false;
  router.events.on('session.cleared', () => {
    fired = true;
  });
  await new Promise((r) => setTimeout(r, ms));
  if (fired) throw new Error('session.cleared fired unexpectedly');
}

describe('router SessionStart clear behavior', () => {
  it('purges inbound/outbound rows on SessionStart with source=clear', async () => {
    await router.ingestInbound({
      adapter: 'fake',
      sessionId: 'sess',
      senderId: '1',
      content: 'hello',
      meta: {},
      files: [],
      receivedAt: new Date(),
    });
    expect(
      (
        db.raw
          .prepare('SELECT COUNT(*) AS c FROM inbound_messages WHERE session_id = ?')
          .get('sess') as { c: number }
      ).c,
    ).toBe(1);

    fireSessionStart('clear');
    const ev = await waitForCleared();

    expect(ev.sessionId).toBe('sess');
    expect(ev.source).toBe('clear');
    expect(ev.counts.inbound).toBe(1);
    const remaining = (
      db.raw
        .prepare('SELECT COUNT(*) AS c FROM inbound_messages WHERE session_id = ?')
        .get('sess') as { c: number }
    ).c;
    expect(remaining).toBe(0);
  });

  it('purges on SessionStart with source=startup', async () => {
    await router.ingestInbound({
      adapter: 'fake',
      sessionId: 'sess',
      senderId: '1',
      content: 'hi',
      meta: {},
      files: [],
      receivedAt: new Date(),
    });
    fireSessionStart('startup');
    const ev = await waitForCleared();
    expect(ev.source).toBe('startup');
    const remaining = (
      db.raw
        .prepare('SELECT COUNT(*) AS c FROM inbound_messages WHERE session_id = ?')
        .get('sess') as { c: number }
    ).c;
    expect(remaining).toBe(0);
  });

  it('does NOT purge on SessionStart with source=resume', async () => {
    await router.ingestInbound({
      adapter: 'fake',
      sessionId: 'sess',
      senderId: '1',
      content: 'keep me',
      meta: {},
      files: [],
      receivedAt: new Date(),
    });
    fireSessionStart('resume');
    await expectNoCleared(400);
    const remaining = (
      db.raw
        .prepare('SELECT COUNT(*) AS c FROM inbound_messages WHERE session_id = ?')
        .get('sess') as { c: number }
    ).c;
    expect(remaining).toBe(1);
  });

  it('does NOT purge on SessionStart with source=compact', async () => {
    await router.ingestInbound({
      adapter: 'fake',
      sessionId: 'sess',
      senderId: '1',
      content: 'keep me',
      meta: {},
      files: [],
      receivedAt: new Date(),
    });
    fireSessionStart('compact');
    await expectNoCleared(400);
    const remaining = (
      db.raw
        .prepare('SELECT COUNT(*) AS c FROM inbound_messages WHERE session_id = ?')
        .get('sess') as { c: number }
    ).c;
    expect(remaining).toBe(1);
  });

  it('wipes media directory and reports mediaWiped=true', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x9, 0x8, 0x7, 0x6]);
    await cacheInboundBlob({
      dataDir: dir,
      sessionId: 'sess',
      bytes: png,
      declaredMime: undefined,
      declaredName: 'a.png',
    });
    expect(existsSync(mediaDirFor(dir, 'sess'))).toBe(true);

    fireSessionStart('clear');
    const ev = await waitForCleared();

    expect(ev.counts.mediaWiped).toBe(true);
    expect(existsSync(mediaDirFor(dir, 'sess'))).toBe(false);
  });

  it('preserves persistent_approvals across a clear', async () => {
    db.raw
      .prepare(
        `INSERT INTO persistent_approvals
           (approval_id, session_id, tool_name, input_signature, created_at, respondent)
         VALUES ('app1', 'sess', 'Bash', 'sig', ?, 'me')`,
      )
      .run(new Date().toISOString());

    fireSessionStart('clear');
    await waitForCleared();

    const cnt = (
      db.raw
        .prepare('SELECT COUNT(*) AS c FROM persistent_approvals WHERE session_id = ?')
        .get('sess') as { c: number }
    ).c;
    expect(cnt).toBe(1);
  });
});
