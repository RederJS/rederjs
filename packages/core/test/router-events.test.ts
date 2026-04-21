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
import type {
  InboundPersistedPayload,
  OutboundPersistedPayload,
  OutboundSentPayload,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  SessionStateChangedPayload,
} from '../src/adapter.js';
import { FakeAdapter } from './fixtures/fake-adapter.js';

let dir: string;
let db: DatabaseHandle;
let ipcServer: IpcServer;
let router: Router;
let socketPath: string;
let token: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-router-events-'));
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

describe('router events', () => {
  it('emits inbound.persisted on ingestInbound', async () => {
    const seen: InboundPersistedPayload[] = [];
    router.events.on('inbound.persisted', (p) => seen.push(p));

    await router.ingestInbound({
      adapter: 'fake',
      sessionId: 'sess',
      senderId: '42',
      content: 'hello',
      meta: { k: 'v' },
      files: [],
      receivedAt: new Date(),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      sessionId: 'sess',
      adapter: 'fake',
      senderId: '42',
      content: 'hello',
      meta: { k: 'v' },
    });
    expect(seen[0]!.messageId).toMatch(/[0-9a-f-]{36}/);
  });

  it('does not emit inbound.persisted on idempotent duplicate', async () => {
    const seen: InboundPersistedPayload[] = [];
    router.events.on('inbound.persisted', (p) => seen.push(p));

    const msg = {
      adapter: 'fake',
      sessionId: 'sess',
      senderId: '42',
      content: 'dup',
      meta: {},
      files: [],
      receivedAt: new Date(),
      idempotencyKey: 'k1',
    };
    await router.ingestInbound(msg);
    await router.ingestInbound(msg);
    expect(seen).toHaveLength(1);
  });

  it('emits outbound.persisted then outbound.sent on successful reply', async () => {
    const adapter = new FakeAdapter('fake');
    router.registerAdapter('fake', { adapter });
    const persisted: OutboundPersistedPayload[] = [];
    const sent: OutboundSentPayload[] = [];
    router.events.on('outbound.persisted', (p) => persisted.push(p));
    router.events.on('outbound.sent', (p) => sent.push(p));

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
        request_id: 'r1',
        content: 'reply!',
        meta: {},
        files: [],
      }),
    );
    await wait(conn, (m) => (m as { kind: string }).kind === 'reply_tool_result');

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.content).toBe('reply!');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.content).toBe('reply!');
    expect(sent[0]?.messageId).toBe(persisted[0]?.messageId);
    conn.socket.end();
  });

  it('emits session.state_changed on connect and disconnect', async () => {
    const seen: SessionStateChangedPayload[] = [];
    router.events.on('session.state_changed', (p) => seen.push(p));

    const conn = await connect(socketPath);
    await authenticate(conn, 'sess', token);
    await new Promise((r) => setTimeout(r, 30));
    expect(seen.some((e) => e.state === 'connected')).toBe(true);

    conn.socket.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.some((e) => e.state === 'disconnected')).toBe(true);
  });

  it('emits permission.requested and permission.resolved', async () => {
    const adapter = new FakeAdapter('fake');
    router.registerAdapter('fake', { adapter });
    const requested: PermissionRequestedPayload[] = [];
    const resolved: PermissionResolvedPayload[] = [];
    router.events.on('permission.requested', (p) => requested.push(p));
    router.events.on('permission.resolved', (p) => resolved.push(p));

    const conn = await connect(socketPath);
    await authenticate(conn, 'sess', token);
    conn.socket.write(
      encode({
        kind: 'permission_request',
        request_id: 'req1',
        tool_name: 'Bash',
        description: 'run',
        input_preview: '{}',
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({
      requestId: 'req1',
      sessionId: 'sess',
      toolName: 'Bash',
    });

    await router.ingestPermissionVerdict({
      requestId: 'req1',
      behavior: 'allow',
      respondent: 'test',
    });
    await wait(conn, (m) => (m as { kind: string }).kind === 'permission_verdict');

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      requestId: 'req1',
      behavior: 'allow',
      respondent: 'test',
    });
    conn.socket.end();
  });
});
