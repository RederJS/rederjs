import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DatabaseHandle } from '../../core/src/storage/db.js';
import { createSession } from '../../core/src/sessions.js';
import { createLogger } from '../../core/src/logger.js';
import { createIpcServer, type IpcServer } from '../../core/src/ipc/server.js';
import { IpcClient } from '../src/ipc-client.js';

let dir: string;
let db: DatabaseHandle;
let server: IpcServer;
let socketPath: string;
let token: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-client-test-'));
  db = openDatabase(join(dir, 'test.db'));
  socketPath = join(dir, 'reder.sock');
  const { token: t } = await createSession(db.raw, 'sess', 'Sess');
  token = t;
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  server = await createIpcServer({ db: db.raw, socketPath, logger, heartbeatTimeoutMs: 2000 });
});

afterEach(async () => {
  await server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ipc client', () => {
  it('connects and completes handshake', async () => {
    const client = new IpcClient({
      socketPath,
      sessionId: 'sess',
      token,
      shimVersion: '0.1.0',
      claudeCodeVersion: '2.1.81',
    });
    await client.connect();
    expect(client.isConnected).toBe(true);
    await client.close();
  });

  it('rejects on bad token', async () => {
    const client = new IpcClient({
      socketPath,
      sessionId: 'sess',
      token: 'rdr_sess_wrong',
      shimVersion: '0.1.0',
      claudeCodeVersion: '2.1.81',
      maxRetryAttempts: 0,
    });
    await expect(client.connect()).rejects.toThrow();
  });

  it('emits channel_event for server-pushed frames', async () => {
    const client = new IpcClient({
      socketPath,
      sessionId: 'sess',
      token,
      shimVersion: '0.1.0',
      claudeCodeVersion: '2.1.81',
    });
    const events: Array<{ message_id: string; content: string }> = [];
    client.on('channel_event', (m) =>
      events.push({ message_id: m.message_id, content: m.content }),
    );
    await client.connect();
    server.sendToSession('sess', {
      kind: 'channel_event',
      message_id: 'm1',
      content: 'hello',
      meta: {},
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toEqual([{ message_id: 'm1', content: 'hello' }]);
    await client.close();
  });

  it('emits permission_verdict', async () => {
    const client = new IpcClient({
      socketPath,
      sessionId: 'sess',
      token,
      shimVersion: '0.1.0',
      claudeCodeVersion: '2.1.81',
    });
    const verdicts: Array<{ request_id: string; behavior: string }> = [];
    client.on('permission_verdict', (v) =>
      verdicts.push({ request_id: v.request_id, behavior: v.behavior }),
    );
    await client.connect();
    server.sendToSession('sess', {
      kind: 'permission_verdict',
      request_id: 'r1',
      behavior: 'allow',
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(verdicts).toEqual([{ request_id: 'r1', behavior: 'allow' }]);
    await client.close();
  });

  it('reconnects with backoff on disconnect', async () => {
    const client = new IpcClient({
      socketPath,
      sessionId: 'sess',
      token,
      shimVersion: '0.1.0',
      claudeCodeVersion: '2.1.81',
      initialRetryDelayMs: 10,
      maxRetryDelayMs: 50,
    });
    const states: string[] = [];
    client.on('status', (s) => states.push(s));
    await client.connect();
    // restart server: close + new one on same path
    await server.close();
    server = await createIpcServer({
      db: db.raw,
      socketPath,
      logger: createLogger({ level: 'error', destination: { write: () => {} } }),
      heartbeatTimeoutMs: 2000,
    });
    // give client time to notice disconnect and reconnect
    await new Promise((r) => setTimeout(r, 300));
    expect(client.isConnected).toBe(true);
    expect(states).toContain('disconnected');
    expect(states).toContain('connected');
    await client.close();
  });

  it('request() returns the matching reply_tool_result', async () => {
    const client = new IpcClient({
      socketPath,
      sessionId: 'sess',
      token,
      shimVersion: '0.1.0',
      claudeCodeVersion: '2.1.81',
    });
    await client.connect();
    server.on('reply_tool_call', (evt) => {
      server.sendToSession(evt.session_id, {
        kind: 'reply_tool_result',
        request_id: evt.request_id,
        success: true,
      });
    });
    const result = await client.sendReply({ request_id: 'r42', content: 'hi' });
    expect(result).toEqual({ success: true });
    await client.close();
  });
});
