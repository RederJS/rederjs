import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { FakeAdapter } from './fixtures/fake-adapter.js';

let dir: string;
let db: DatabaseHandle;
let ipcServer: IpcServer;
let router: Router;
let socketPath: string;
let token: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-router-test-'));
  db = openDatabase(join(dir, 'test.db'));
  socketPath = join(dir, 'reder.sock');
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  const audit = createAuditLog(dir);
  ipcServer = await createIpcServer({ db: db.raw, socketPath, logger, heartbeatTimeoutMs: 3000 });
  router = createRouter({ db: db.raw, ipcServer, logger, audit, outboundInitialBackoffMs: 5 });
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

describe('router inbound', () => {
  it('persists and immediately delivers when shim is connected', async () => {
    const conn = await connect(socketPath);
    await authenticate(conn, 'sess', token);
    await router.ingestInbound({
      adapter: 'fake',
      sessionId: 'sess',
      senderId: '42',
      content: 'hello',
      meta: {},
      files: [],
      receivedAt: new Date(),
    });
    const evt = (await wait(conn, (m) => (m as { kind: string }).kind === 'channel_event')) as {
      content: string;
    };
    expect(evt.content).toBe('hello');
    // After ack, row should be acknowledged.
    conn.socket.write(
      encode({
        kind: 'channel_ack',
        message_id: (evt as unknown as { message_id: string }).message_id,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    const row = db.raw.prepare('SELECT state FROM inbound_messages LIMIT 1').get() as {
      state: string;
    };
    expect(row.state).toBe('acknowledged');
    conn.socket.end();
  });

  it('queues when shim not connected and flushes on shim_connected', async () => {
    await router.ingestInbound({
      adapter: 'fake',
      sessionId: 'sess',
      senderId: '42',
      content: 'one',
      meta: {},
      files: [],
      receivedAt: new Date(),
    });
    await router.ingestInbound({
      adapter: 'fake',
      sessionId: 'sess',
      senderId: '42',
      content: 'two',
      meta: {},
      files: [],
      receivedAt: new Date(),
    });
    // no shim connected → rows stay as received
    const pendingBefore = db.raw
      .prepare(`SELECT COUNT(*) as c FROM inbound_messages WHERE state = 'received'`)
      .get() as { c: number };
    expect(pendingBefore.c).toBe(2);

    const conn = await connect(socketPath);
    await authenticate(conn, 'sess', token);
    // flush is async; wait for two channel_events
    const events: unknown[] = [];
    await new Promise<void>((resolve) => {
      conn.pending.push((msg) => {
        if ((msg as { kind: string }).kind === 'channel_event') {
          events.push(msg);
          if (events.length === 2) {
            resolve();
            return true;
          }
        }
        return false;
      });
      // also check already-received
      for (const msg of conn.received) {
        if ((msg as { kind: string }).kind === 'channel_event') {
          events.push(msg);
          if (events.length === 2) resolve();
        }
      }
    });
    expect(events.map((e) => (e as { content: string }).content)).toEqual(['one', 'two']);
    conn.socket.end();
  });

  it('deduplicates by idempotency_key', async () => {
    const conn = await connect(socketPath);
    await authenticate(conn, 'sess', token);
    const base = {
      adapter: 'fake',
      sessionId: 'sess',
      senderId: '1',
      content: 'dup',
      meta: {},
      files: [],
      receivedAt: new Date(),
      idempotencyKey: 'k1',
    };
    await router.ingestInbound(base);
    await router.ingestInbound(base);
    const count = db.raw.prepare('SELECT COUNT(*) as c FROM inbound_messages').get() as {
      c: number;
    };
    expect(count.c).toBe(1);
    conn.socket.end();
  });
});

describe('router outbound (reply tool)', () => {
  it('sends reply via registered adapter and resolves tool call', async () => {
    const adapter = new FakeAdapter('fake');
    router.registerAdapter('fake', { adapter });

    // prime the lastInbound map: do an ingestInbound so recipient can be resolved
    const conn = await connect(socketPath);
    await authenticate(conn, 'sess', token);
    await router.ingestInbound({
      adapter: 'fake',
      sessionId: 'sess',
      senderId: '42',
      content: 'incoming',
      meta: {},
      files: [],
      receivedAt: new Date(),
    });
    await wait(conn, (m) => (m as { kind: string }).kind === 'channel_event');

    // shim sends reply_tool_call
    conn.socket.write(
      encode({
        kind: 'reply_tool_call',
        request_id: 'r1',
        content: 'claude replies',
        meta: {},
        files: [],
      }),
    );
    const result = (await wait(
      conn,
      (m) => (m as { kind: string }).kind === 'reply_tool_result',
    )) as { request_id: string; success: boolean };
    expect(result).toMatchObject({ request_id: 'r1', success: true });
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.recipient).toBe('42');
    expect(adapter.sent[0]!.content).toBe('claude replies');
    conn.socket.end();
  });

  it('retries retriable failures then succeeds', async () => {
    const adapter = new FakeAdapter('fake');
    adapter.nextSendBehavior = 'retriable';
    adapter.retriableAttemptsLeft = 2;
    router.registerAdapter('fake', { adapter });

    const conn = await connect(socketPath);
    await authenticate(conn, 'sess', token);
    await router.ingestInbound({
      adapter: 'fake',
      sessionId: 'sess',
      senderId: '42',
      content: 'x',
      meta: {},
      files: [],
      receivedAt: new Date(),
    });
    await wait(conn, (m) => (m as { kind: string }).kind === 'channel_event');

    conn.socket.write(
      encode({ kind: 'reply_tool_call', request_id: 'r2', content: 'reply', meta: {}, files: [] }),
    );
    const result = (await wait(
      conn,
      (m) => (m as { kind: string }).kind === 'reply_tool_result',
    )) as { success: boolean };
    expect(result.success).toBe(true);
    expect(adapter.sendResults.filter((r) => !r.success)).toHaveLength(2);
    expect(adapter.sendResults[2]?.success).toBe(true);
    conn.socket.end();
  });

  it('returns non-retriable failure as error', async () => {
    const adapter = new FakeAdapter('fake');
    adapter.nextSendBehavior = 'terminal';
    router.registerAdapter('fake', { adapter });

    const conn = await connect(socketPath);
    await authenticate(conn, 'sess', token);
    await router.ingestInbound({
      adapter: 'fake',
      sessionId: 'sess',
      senderId: '42',
      content: 'x',
      meta: {},
      files: [],
      receivedAt: new Date(),
    });
    await wait(conn, (m) => (m as { kind: string }).kind === 'channel_event');

    conn.socket.write(
      encode({ kind: 'reply_tool_call', request_id: 'r3', content: 'reply', meta: {}, files: [] }),
    );
    const result = (await wait(
      conn,
      (m) => (m as { kind: string }).kind === 'reply_tool_result',
    )) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('terminal');
    conn.socket.end();
  });

  it('fails reply when no recipient is bound', async () => {
    const adapter = new FakeAdapter('fake');
    router.registerAdapter('fake', { adapter });
    const conn = await connect(socketPath);
    await authenticate(conn, 'sess', token);
    conn.socket.write(
      encode({ kind: 'reply_tool_call', request_id: 'r4', content: 'x', meta: {}, files: [] }),
    );
    const result = (await wait(
      conn,
      (m) => (m as { kind: string }).kind === 'reply_tool_result',
    )) as { success: boolean };
    expect(result.success).toBe(false);
    conn.socket.end();
  });
});

describe('router permission flow', () => {
  it('dispatches prompt to adapter and forwards verdict to shim', async () => {
    const adapter = new FakeAdapter('fake');
    router.registerAdapter('fake', { adapter });
    const conn = await connect(socketPath);
    await authenticate(conn, 'sess', token);

    // shim → daemon: permission_request
    conn.socket.write(
      encode({
        kind: 'permission_request',
        request_id: 'abcde',
        tool_name: 'Bash',
        description: 'run tests',
        input_preview: '{"command":"npm test"}',
      }),
    );
    // wait for adapter to receive prompt
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no prompt')), 2000);
      const check = (): void => {
        if (adapter.prompts.length > 0) {
          clearTimeout(timer);
          resolve();
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
    expect(adapter.prompts[0]?.requestId).toBe('abcde');

    // adapter → router: ingestPermissionVerdict
    await router.ingestPermissionVerdict({
      requestId: 'abcde',
      behavior: 'allow',
      respondent: 'user@tg',
    });
    const verdict = (await wait(
      conn,
      (m) => (m as { kind: string }).kind === 'permission_verdict',
    )) as { request_id: string; behavior: string };
    expect(verdict).toMatchObject({ request_id: 'abcde', behavior: 'allow' });
    expect(adapter.canceled.map((c) => c.requestId)).toContain('abcde');
    conn.socket.end();
  });

  it('persists approvals when verdict includes persistent=true and short-circuits next time', async () => {
    const adapter = new FakeAdapter('fake');
    router.registerAdapter('fake', { adapter });
    const conn = await connect(socketPath);
    await authenticate(conn, 'sess', token);

    conn.socket.write(
      encode({
        kind: 'permission_request',
        request_id: 'r1',
        tool_name: 'Bash',
        description: 'run tests',
        input_preview: '{"command":"npm test"}',
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    await router.ingestPermissionVerdict({
      requestId: 'r1',
      behavior: 'allow',
      respondent: 'user',
      persistent: true,
    });
    await wait(conn, (m) => (m as { kind: string }).kind === 'permission_verdict');

    // second request with same tool_name + input_preview → auto-allow, no adapter prompt
    adapter.prompts.length = 0;
    conn.socket.write(
      encode({
        kind: 'permission_request',
        request_id: 'r2',
        tool_name: 'Bash',
        description: 'run tests',
        input_preview: '{"command":"npm test"}',
      }),
    );
    const verdict = (await wait(
      conn,
      (m) =>
        (m as { kind: string }).kind === 'permission_verdict' &&
        (m as { request_id: string }).request_id === 'r2',
    )) as { behavior: string };
    expect(verdict.behavior).toBe('allow');
    expect(adapter.prompts).toHaveLength(0);
    conn.socket.end();
  });

  it('times out to deny by default', async () => {
    const adapter = new FakeAdapter('fake');
    router.registerAdapter('fake', { adapter });
    // Replace permissions with a shorter timeout for this test.
    await router.stop();
    const logger = createLogger({ level: 'error', destination: { write: () => {} } });
    const audit = createAuditLog(dir);
    router = createRouter({
      db: db.raw,
      ipcServer,
      logger,
      audit,
      permissions: { timeoutSeconds: 0.05, defaultOnTimeout: 'deny' },
      outboundInitialBackoffMs: 5,
    });
    router.registerAdapter('fake', { adapter });

    const conn = await connect(socketPath);
    await authenticate(conn, 'sess', token);
    conn.socket.write(
      encode({
        kind: 'permission_request',
        request_id: 'rq1',
        tool_name: 'Bash',
        description: 'slow',
        input_preview: '{}',
      }),
    );
    const verdict = (await wait(
      conn,
      (m) => (m as { kind: string }).kind === 'permission_verdict',
      2000,
    )) as { behavior: string };
    expect(verdict.behavior).toBe('deny');
    expect(adapter.canceled.find((c) => c.requestId === 'rq1')?.finalVerdict).toBe('timeout');
    conn.socket.end();
  });
});
