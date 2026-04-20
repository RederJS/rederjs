import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { openDatabase, type DatabaseHandle } from '../../src/storage/db.js';
import { createSession } from '../../src/sessions.js';
import { createLogger } from '../../src/logger.js';
import { encode, FrameDecoder } from '../../src/ipc/codec.js';
import { createIpcServer, type IpcServer } from '../../src/ipc/server.js';

let dir: string;
let db: DatabaseHandle;
let server: IpcServer;
let socketPath: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-ipc-test-'));
  db = openDatabase(join(dir, 'test.db'));
  socketPath = join(dir, 'reder.sock');
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  server = await createIpcServer({
    db: db.raw,
    socketPath,
    logger,
    heartbeatTimeoutMs: 2000,
  });
});

afterEach(async () => {
  await server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface TestClient {
  socket: Socket;
  decoder: FrameDecoder;
  received: unknown[];
  pendingWaiters: Array<(msg: unknown) => boolean>;
}

function connect(path: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    const client: TestClient = { socket, decoder: new FrameDecoder(), received: [], pendingWaiters: [] };
    socket.on('data', (chunk) => {
      for (const frame of client.decoder.push(chunk)) {
        client.received.push(frame);
        for (let i = client.pendingWaiters.length - 1; i >= 0; i--) {
          if (client.pendingWaiters[i]!(frame)) {
            client.pendingWaiters.splice(i, 1);
          }
        }
      }
    });
    socket.on('error', reject);
    socket.on('connect', () => resolve(client));
  });
}

function waitFor(client: TestClient, predicate: (msg: unknown) => boolean, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    for (const msg of client.received) {
      if (predicate(msg)) {
        resolve(msg);
        return;
      }
    }
    const timer = setTimeout(() => reject(new Error('timeout waiting for frame')), timeoutMs);
    client.pendingWaiters.push((msg) => {
      if (predicate(msg)) {
        clearTimeout(timer);
        resolve(msg);
        return true;
      }
      return false;
    });
  });
}

function closeClient(c: TestClient): Promise<void> {
  return new Promise((resolve) => {
    c.socket.once('close', () => resolve());
    c.socket.end();
  });
}

describe('ipc server', () => {
  it('creates the socket with mode 0600', () => {
    const mode = statSync(socketPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rejects hello with wrong token and sends error frame', async () => {
    await createSession(db.raw, 'booknerds', 'BN');
    const client = await connect(socketPath);
    client.socket.write(
      encode({
        kind: 'hello',
        session_id: 'booknerds',
        shim_token: 'rdr_sess_wrong',
        shim_version: '0.1.0',
        claude_code_version: '2.1.81',
      }),
    );
    const err = await waitFor(client, (m) => (m as { kind: string }).kind === 'error');
    expect(err).toMatchObject({ kind: 'error', code: 'AUTH' });
    await closeClient(client);
  });

  it('accepts hello with correct token and sends welcome', async () => {
    const { token } = await createSession(db.raw, 'booknerds', 'BN');
    const client = await connect(socketPath);
    client.socket.write(
      encode({
        kind: 'hello',
        session_id: 'booknerds',
        shim_token: token,
        shim_version: '0.1.0',
        claude_code_version: '2.1.81',
      }),
    );
    const welcome = await waitFor(client, (m) => (m as { kind: string }).kind === 'welcome');
    expect(welcome).toMatchObject({ kind: 'welcome', session_id: 'booknerds', protocol_version: 1 });
    await closeClient(client);
  });

  it('responds to ping with pong', async () => {
    const { token } = await createSession(db.raw, 'x', 'X');
    const client = await connect(socketPath);
    client.socket.write(
      encode({
        kind: 'hello',
        session_id: 'x',
        shim_token: token,
        shim_version: '0.1.0',
        claude_code_version: '2.1.81',
      }),
    );
    await waitFor(client, (m) => (m as { kind: string }).kind === 'welcome');
    client.socket.write(encode({ kind: 'ping' }));
    const pong = await waitFor(client, (m) => (m as { kind: string }).kind === 'pong');
    expect(pong).toEqual({ kind: 'pong' });
    await closeClient(client);
  });

  it('emits a shim_connected event after successful handshake', async () => {
    const events: string[] = [];
    server.on('shim_connected', (sid) => events.push(`up:${sid}`));
    server.on('shim_disconnected', (sid) => events.push(`down:${sid}`));
    const { token } = await createSession(db.raw, 'x', 'X');
    const client = await connect(socketPath);
    client.socket.write(
      encode({
        kind: 'hello',
        session_id: 'x',
        shim_token: token,
        shim_version: '0.1.0',
        claude_code_version: '2.1.81',
      }),
    );
    await waitFor(client, (m) => (m as { kind: string }).kind === 'welcome');
    expect(events).toContain('up:x');
    await closeClient(client);
    // disconnect fires asynchronously
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toContain('down:x');
  });

  it('sendToSession delivers a channel_event to the authenticated connection', async () => {
    const { token } = await createSession(db.raw, 'x', 'X');
    const client = await connect(socketPath);
    client.socket.write(
      encode({
        kind: 'hello',
        session_id: 'x',
        shim_token: token,
        shim_version: '0.1.0',
        claude_code_version: '2.1.81',
      }),
    );
    await waitFor(client, (m) => (m as { kind: string }).kind === 'welcome');
    const sent = server.sendToSession('x', {
      kind: 'channel_event',
      message_id: 'm1',
      content: 'hello',
      meta: { chat_id: '42' },
    });
    expect(sent).toBe(true);
    const msg = await waitFor(client, (m) => (m as { kind: string }).kind === 'channel_event');
    expect(msg).toMatchObject({ kind: 'channel_event', message_id: 'm1', content: 'hello' });
    await closeClient(client);
  });

  it('sendToSession returns false when session not connected', () => {
    expect(server.sendToSession('nosuch', { kind: 'pong' })).toBe(false);
  });

  it('routes reply_tool_call to the reply handler with session_id', async () => {
    const calls: Array<{ session_id: string; request_id: string; content: string }> = [];
    server.on('reply_tool_call', (msg) =>
      calls.push({ session_id: msg.session_id, request_id: msg.request_id, content: msg.content }),
    );
    const { token } = await createSession(db.raw, 'x', 'X');
    const client = await connect(socketPath);
    client.socket.write(
      encode({
        kind: 'hello',
        session_id: 'x',
        shim_token: token,
        shim_version: '0.1.0',
        claude_code_version: '2.1.81',
      }),
    );
    await waitFor(client, (m) => (m as { kind: string }).kind === 'welcome');
    client.socket.write(
      encode({ kind: 'reply_tool_call', request_id: 'r1', content: 'hi', meta: {}, files: [] }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([{ session_id: 'x', request_id: 'r1', content: 'hi' }]);
    await closeClient(client);
  });

  it('rejects frames before hello with an error and closes', async () => {
    const client = await connect(socketPath);
    client.socket.write(encode({ kind: 'ping' }));
    const err = await waitFor(client, (m) => (m as { kind: string }).kind === 'error');
    expect(err).toMatchObject({ kind: 'error' });
    await closeClient(client);
  });

  it('supports two sessions on two concurrent connections', async () => {
    const { token: t1 } = await createSession(db.raw, 's1', 'S1');
    const { token: t2 } = await createSession(db.raw, 's2', 'S2');
    const c1 = await connect(socketPath);
    const c2 = await connect(socketPath);
    c1.socket.write(
      encode({
        kind: 'hello',
        session_id: 's1',
        shim_token: t1,
        shim_version: '0',
        claude_code_version: '2',
      }),
    );
    c2.socket.write(
      encode({
        kind: 'hello',
        session_id: 's2',
        shim_token: t2,
        shim_version: '0',
        claude_code_version: '2',
      }),
    );
    await waitFor(c1, (m) => (m as { kind: string }).kind === 'welcome');
    await waitFor(c2, (m) => (m as { kind: string }).kind === 'welcome');
    server.sendToSession('s1', { kind: 'channel_event', message_id: 'a', content: 'for-s1', meta: {} });
    server.sendToSession('s2', { kind: 'channel_event', message_id: 'b', content: 'for-s2', meta: {} });
    const m1 = (await waitFor(c1, (m) => (m as { kind: string }).kind === 'channel_event')) as {
      content: string;
    };
    const m2 = (await waitFor(c2, (m) => (m as { kind: string }).kind === 'channel_event')) as {
      content: string;
    };
    expect(m1.content).toBe('for-s1');
    expect(m2.content).toBe('for-s2');
    await closeClient(c1);
    await closeClient(c2);
  });
});
