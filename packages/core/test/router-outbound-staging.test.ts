import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { decodeAttachmentsMeta } from '../src/media.js';
import { FakeAdapter } from './fixtures/fake-adapter.js';

let dir: string;
let db: DatabaseHandle;
let ipcServer: IpcServer;
let router: Router;
let socketPath: string;
let token: string;
let adapter: FakeAdapter;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-router-staging-'));
  db = openDatabase(join(dir, 'test.db'));
  socketPath = join(dir, 'reder.sock');
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  const audit = createAuditLog(dir);
  ipcServer = await createIpcServer({ db: db.raw, socketPath, logger, heartbeatTimeoutMs: 3000 });
  router = createRouter({
    db: db.raw,
    ipcServer,
    logger,
    audit,
    outboundInitialBackoffMs: 5,
    dataDir: dir,
  });
  adapter = new FakeAdapter('fake');
  router.registerAdapter('fake', { adapter });
  const { token: t } = await createSession(db.raw, 'sess', 'Sess');
  token = t;
});

afterEach(async () => {
  await router.stop();
  await ipcServer.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

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

function wait(conn: TestConn, pred: (msg: unknown) => boolean, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    for (const msg of conn.received) {
      if (pred(msg)) return resolve(msg);
    }
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    conn.pending.push((msg) => {
      if (pred(msg)) {
        clearTimeout(timer);
        resolve(msg);
        return true;
      }
      return false;
    });
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
  await wait(conn, (m) => (m as { kind: string }).kind === 'welcome');
}

/** Minimal valid 1×1 PNG bytes */
function minimalPng(): Buffer {
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
      '2e00000000c49444154789c6260f8cfc00000000200016dd8425900000000' +
      '49454e44ae426082',
    'hex',
  );
}

describe('router outbound staging', () => {
  it('success path — stages PNG into media cache and builds attachments meta', async () => {
    // Write a real PNG to a temp source file.
    const pngPath = join(dir, 'source.png');
    writeFileSync(pngPath, minimalPng());

    const conn = await connect(socketPath);
    await authenticate(conn, 'sess', token);

    // Ingest an inbound so the router has a recipient binding.
    await router.ingestInbound({
      adapter: 'fake',
      sessionId: 'sess',
      senderId: '42',
      content: 'in',
      meta: {},
      files: [],
      receivedAt: new Date(),
    });
    await wait(conn, (m) => (m as { kind: string }).kind === 'channel_event');

    conn.socket.write(
      encode({
        kind: 'reply_tool_call',
        request_id: 'r1',
        content: 'here is your image',
        meta: {},
        files: [pngPath],
      }),
    );
    const result = (await wait(
      conn,
      (m) => (m as { kind: string }).kind === 'reply_tool_result',
    )) as { success: boolean; error?: string };

    expect(result.success).toBe(true);
    expect(adapter.sent).toHaveLength(1);

    const outbound = adapter.sent[0]!;
    expect(outbound.files).toHaveLength(1);
    expect(outbound.files[0]).toMatch(
      new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/media/sessions/sess/`),
    );
    expect(outbound.files[0]).toMatch(/\.png$/);

    const refs = decodeAttachmentsMeta(outbound.meta['attachments']);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.kind).toBe('image');
    expect(refs[0]!.mime).toBe('image/png');

    conn.socket.end();
  });

  it('missing-file failure — returns error and never dispatches', async () => {
    const conn = await connect(socketPath);
    await authenticate(conn, 'sess', token);

    await router.ingestInbound({
      adapter: 'fake',
      sessionId: 'sess',
      senderId: '42',
      content: 'in',
      meta: {},
      files: [],
      receivedAt: new Date(),
    });
    await wait(conn, (m) => (m as { kind: string }).kind === 'channel_event');

    conn.socket.write(
      encode({
        kind: 'reply_tool_call',
        request_id: 'r2',
        content: 'reply with missing file',
        meta: {},
        files: ['/no/such/file.png'],
      }),
    );
    const result = (await wait(
      conn,
      (m) => (m as { kind: string }).kind === 'reply_tool_result',
    )) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    // Error should mention the path or "not exist"
    expect(result.error!.toLowerCase()).toMatch(/\/no\/such\/file\.png|not exist|does not exist/);

    expect(adapter.sent).toHaveLength(0);

    conn.socket.end();
  });
});
