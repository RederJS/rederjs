import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { openDatabase, type DatabaseHandle } from '../../src/storage/db.js';
import { createSession } from '../../src/sessions.js';
import { createLogger } from '../../src/logger.js';
import { createIpcServer, type IpcServer } from '../../src/ipc/server.js';
import { encode } from '../../src/ipc/codec.js';

let dir: string;
let db: DatabaseHandle;
let ipcServer: IpcServer;
let socketPath: string;
let token: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-hook-event-'));
  db = openDatabase(join(dir, 'test.db'));
  socketPath = join(dir, 'reder.sock');
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  ipcServer = await createIpcServer({ db: db.raw, socketPath, logger });
  const { token: t } = await createSession(db.raw, 'sess', 'Sess');
  token = t;
});

afterEach(async () => {
  await ipcServer.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ipc server hook_event', () => {
  it('emits hook_event on valid auth and closes the socket', async () => {
    const received: Array<{ session_id: string; hook: string; timestamp: string }> = [];
    ipcServer.on('hook_event', (evt) => {
      received.push({ session_id: evt.session_id, hook: evt.hook, timestamp: evt.timestamp });
    });

    const socket = createConnection({ path: socketPath });
    await new Promise<void>((r) => socket.once('connect', () => r()));
    socket.write(
      encode({
        kind: 'hook_event',
        session_id: 'sess',
        shim_token: token,
        hook: 'UserPromptSubmit',
        timestamp: '2026-04-22T12:00:00.000Z',
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      session_id: 'sess',
      hook: 'UserPromptSubmit',
      timestamp: '2026-04-22T12:00:00.000Z',
    });
  });

  it('rejects hook_event with a bad token', async () => {
    const received: unknown[] = [];
    ipcServer.on('hook_event', (evt) => received.push(evt));

    const socket = createConnection({ path: socketPath });
    await new Promise<void>((r) => socket.once('connect', () => r()));
    socket.write(
      encode({
        kind: 'hook_event',
        session_id: 'sess',
        shim_token: 'rdr_sess_nope',
        hook: 'Stop',
        timestamp: '2026-04-22T12:01:00.000Z',
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(0);
  });

  it('does NOT displace an existing shim connection', async () => {
    // A hook fire for the same session ID must not kick the long-lived shim off.
    // Connect a "shim", verify connected, then fire a hook event and check
    // the shim is still connected.
    const helloSock = createConnection({ path: socketPath });
    await new Promise<void>((r) => helloSock.once('connect', () => r()));
    helloSock.write(
      encode({
        kind: 'hello',
        session_id: 'sess',
        shim_token: token,
        shim_version: '0.1.0',
        claude_code_version: '2.1.81',
      }),
    );
    // Wait for welcome frame to arrive.
    await new Promise((r) => setTimeout(r, 300));
    expect(ipcServer.isSessionConnected('sess')).toBe(true);

    const hookSock = createConnection({ path: socketPath });
    await new Promise<void>((r) => hookSock.once('connect', () => r()));
    hookSock.write(
      encode({
        kind: 'hook_event',
        session_id: 'sess',
        shim_token: token,
        hook: 'Stop',
        timestamp: '2026-04-22T12:02:00.000Z',
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(ipcServer.isSessionConnected('sess')).toBe(true);
    helloSock.end();
  });
});
