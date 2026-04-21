import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { openDatabase, type DatabaseHandle } from '../../core/src/storage/db.js';
import { createSession } from '../../core/src/sessions.js';
import { createLogger } from '../../core/src/logger.js';
import { createAuditLog } from '../../core/src/audit.js';
import { createIpcServer, type IpcServer } from '../../core/src/ipc/server.js';
import { createRouter, type Router } from '../../core/src/router.js';
import { createAdapterStorage } from '../../core/src/storage/kv.js';
import { isPaired } from '../../core/src/pairing.js';
import type { AdapterContext } from '../../core/src/adapter.js';
import { encode, FrameDecoder } from '../../core/src/ipc/codec.js';
import { TelegramAdapter } from '../src/index.js';
import { FakeTelegramTransport } from './fake-transport.js';

let dir: string;
let db: DatabaseHandle;
let router: Router;
let ipcServer: IpcServer;
let adapter: TelegramAdapter;
let fake: FakeTelegramTransport;
let socketPath: string;
let sessionToken: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-tg-pair-test-'));
  db = openDatabase(join(dir, 'test.db'));
  const { token } = await createSession(db.raw, 'booknerds', 'BookNerds');
  sessionToken = token;
  socketPath = join(dir, 'reder.sock');
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  const audit = createAuditLog(dir);
  ipcServer = await createIpcServer({ db: db.raw, socketPath, logger });
  router = createRouter({ db: db.raw, ipcServer, logger, audit });

  fake = new FakeTelegramTransport();

  adapter = new TelegramAdapter({ transportFactory: () => fake });
  const ctx: AdapterContext = {
    logger: logger.child({ component: 'adapter.telegram' }),
    config: {
      bots: [{ token: 'fake-token', session_id: 'booknerds' }],
      long_poll_timeout_seconds: 1,
    },
    storage: createAdapterStorage(db.raw, 'telegram'),
    router,
    dataDir: dir,
    sessions: [],
  };
  await adapter.start(ctx);
  router.registerAdapter('telegram', { adapter });
});

afterEach(async () => {
  await adapter.stop();
  await ipcServer.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('TelegramAdapter pairing + allowlist', () => {
  it('sends a pairing code on first DM from unpaired sender', async () => {
    fake.enqueueText({ update_id: 1, chatId: 42, senderId: 99, text: 'hi' });
    await waitFor(() => fake.sent.length > 0, 2000);
    expect(fake.sent[0]!.text).toContain('pairing code');
    const code = extractPairCode(fake.sent[0]!.text);
    expect(code).toMatch(/^[a-z0-9]{6}$/);
    // Row exists in pair_codes
    const rows = db.raw.prepare('SELECT * FROM pair_codes').all() as Array<{ code: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code).toBe(code);
  });

  it('does not forward unpaired messages to the router', async () => {
    const received: unknown[] = [];
    const original = router.ingestInbound.bind(router);
    router.ingestInbound = async (m) => {
      received.push(m);
      return original(m);
    };
    fake.enqueueText({ update_id: 1, chatId: 42, senderId: 99, text: 'hi' });
    await waitFor(() => fake.sent.length > 0, 2000);
    expect(received).toHaveLength(0);
  });

  it('redeems a pair code via IPC admin_pair_request and binds the sender', async () => {
    fake.enqueueText({ update_id: 1, chatId: 42, senderId: 99, text: 'hi' });
    await waitFor(() => fake.sent.length > 0, 2000);
    const code = extractPairCode(fake.sent[0]!.text)!;

    const conn = await connect(socketPath);
    conn.socket.write(
      encode({
        kind: 'hello',
        session_id: 'booknerds',
        shim_token: sessionToken,
        shim_version: '0.1.0',
        claude_code_version: '2.1.81',
      }),
    );
    await wait(conn, (m) => (m as { kind: string }).kind === 'welcome');

    conn.socket.write(encode({ kind: 'admin_pair_request', code }));
    const result = (await wait(
      conn,
      (m) => (m as { kind: string }).kind === 'admin_pair_result',
    )) as { success: boolean; adapter: string; sender_id: string };
    expect(result.success).toBe(true);
    expect(result.adapter).toBe('telegram');
    expect(result.sender_id).toBe('99');

    expect(isPaired(db.raw, 'telegram', '99', 'booknerds')).toBe(true);
    conn.socket.end();
  });

  it('notifies the Telegram user after successful pairing via onPairingCompleted', async () => {
    fake.enqueueText({ update_id: 1, chatId: 42, senderId: 99, text: 'hi' });
    await waitFor(() => fake.sent.length > 0, 2000);
    const code = extractPairCode(fake.sent[0]!.text)!;

    const conn = await connect(socketPath);
    conn.socket.write(
      encode({
        kind: 'hello',
        session_id: 'booknerds',
        shim_token: sessionToken,
        shim_version: '0.1.0',
        claude_code_version: '2.1.81',
      }),
    );
    await wait(conn, (m) => (m as { kind: string }).kind === 'welcome');

    const sentBefore = fake.sent.length;
    conn.socket.write(encode({ kind: 'admin_pair_request', code }));
    await wait(conn, (m) => (m as { kind: string }).kind === 'admin_pair_result');
    await waitFor(() => fake.sent.length > sentBefore, 2000);
    const newMsg = fake.sent[fake.sent.length - 1]!;
    expect(newMsg.text).toContain('Paired');
    conn.socket.end();
  });

  it('admin_pair_request with unknown code returns success:false', async () => {
    const conn = await connect(socketPath);
    conn.socket.write(
      encode({
        kind: 'hello',
        session_id: 'booknerds',
        shim_token: sessionToken,
        shim_version: '0.1.0',
        claude_code_version: '2.1.81',
      }),
    );
    await wait(conn, (m) => (m as { kind: string }).kind === 'welcome');
    conn.socket.write(encode({ kind: 'admin_pair_request', code: 'nothin' }));
    const result = (await wait(
      conn,
      (m) => (m as { kind: string }).kind === 'admin_pair_result',
    )) as { success: boolean };
    expect(result.success).toBe(false);
    conn.socket.end();
  });

  it('rate-limits message delivery after 60 messages in 1 minute', async () => {
    adapter = new TelegramAdapter({
      transportFactory: () => fake,
      rateLimitPerMinute: 3,
    });
    await adapter.stop();
    // Re-create adapter with low limit
    const newFake = new FakeTelegramTransport();
    const newAdapter = new TelegramAdapter({
      transportFactory: () => newFake,
      rateLimitPerMinute: 3,
    });
    const logger = createLogger({ level: 'error', destination: { write: () => {} } });
    const audit = createAuditLog(dir);
    const newRouter = createRouter({ db: db.raw, ipcServer, logger, audit });
    const newCtx: AdapterContext = {
      logger: logger.child({ component: 'adapter.telegram' }),
      config: {
        bots: [{ token: 'fake-token', session_id: 'booknerds' }],
        long_poll_timeout_seconds: 1,
      },
      storage: createAdapterStorage(db.raw, 'telegram'),
      router: newRouter,
      dataDir: dir,
      sessions: [],
    };
    await newAdapter.start(newCtx);
    // Pre-bind so rate limit is exercised (not pairing flow).
    db.raw
      .prepare(
        `INSERT INTO bindings (binding_id, session_id, adapter, sender_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('b1', 'booknerds', 'telegram', '77', new Date().toISOString());

    const ingested: unknown[] = [];
    const orig = newRouter.ingestInbound.bind(newRouter);
    newRouter.ingestInbound = async (m) => {
      ingested.push(m);
      return orig(m);
    };
    for (let i = 1; i <= 5; i++) {
      newFake.enqueueText({ update_id: i, chatId: 50, senderId: 77, text: `m${i}`, messageId: i });
    }
    await waitFor(() => ingested.length >= 3, 2000);
    await new Promise((r) => setTimeout(r, 200));
    expect(ingested.length).toBe(3);
    // Should have sent rate limit reply for the 4th and 5th
    const rlReplies = newFake.sent.filter((s) => s.text.includes('Rate limit'));
    expect(rlReplies.length).toBeGreaterThanOrEqual(1);
    await newAdapter.stop();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function extractPairCode(text: string): string | null {
  const m = text.match(/\*([a-z0-9]{6})\*/) ?? text.match(/\b([a-z0-9]{6})\b/);
  return m ? m[1]! : null;
}

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

function wait(
  conn: TestConn,
  predicate: (msg: unknown) => boolean,
  timeoutMs = 2000,
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
