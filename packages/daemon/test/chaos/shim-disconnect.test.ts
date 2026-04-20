import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { openDatabase, type DatabaseHandle } from '../../../core/src/storage/db.js';
import { createSession } from '../../../core/src/sessions.js';
import { createLogger } from '../../../core/src/logger.js';
import { createAuditLog } from '../../../core/src/audit.js';
import { createIpcServer, type IpcServer } from '../../../core/src/ipc/server.js';
import { createRouter, type Router } from '../../../core/src/router.js';
import { encode, FrameDecoder } from '../../../core/src/ipc/codec.js';

/**
 * NFR-R2 proxy: simulates repeated shim disconnects during active traffic.
 * Every N frames we tear down the shim connection and reconnect; the router
 * should flush the queue on reconnect and no acknowledged inbound message
 * should be lost or duplicated.
 */

let dir: string;
let db: DatabaseHandle;
let ipcServer: IpcServer;
let router: Router;
let socketPath: string;
let token: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-chaos-shim-'));
  db = openDatabase(join(dir, 'test.db'));
  const { token: t } = await createSession(db.raw, 'ss', 'Sess');
  token = t;
  socketPath = join(dir, 'reder.sock');
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  const audit = createAuditLog(dir);
  ipcServer = await createIpcServer({ db: db.raw, socketPath, logger });
  router = createRouter({ db: db.raw, ipcServer, logger, audit });
});

afterEach(async () => {
  await router.stop();
  await ipcServer.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface AutoAckConn {
  socket: Socket;
  welcome: Promise<void>;
  destroy(): void;
}

function connectAutoAck(): AutoAckConn {
  const socket = createConnection({ path: socketPath });
  const decoder = new FrameDecoder();
  let resolveWelcome!: () => void;
  const welcome = new Promise<void>((resolve) => {
    resolveWelcome = resolve;
  });

  socket.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      const msg = frame as { kind: string; message_id?: string };
      if (msg.kind === 'welcome') {
        resolveWelcome();
        continue;
      }
      if (msg.kind === 'channel_event' && msg.message_id) {
        socket.write(encode({ kind: 'channel_ack', message_id: msg.message_id }));
      }
    }
  });

  socket.once('connect', () => {
    socket.write(
      encode({
        kind: 'hello',
        session_id: 'ss',
        shim_token: token,
        shim_version: '0.1.0',
        claude_code_version: '2.1.81',
      }),
    );
  });
  socket.on('error', () => {
    // swallow — we destroy intentionally
  });

  return {
    socket,
    welcome,
    destroy: () => socket.destroy(),
  };
}

describe('NFR-R2: shim disconnect chaos', () => {
  it('delivers all 100 ingests exactly once with repeated shim disconnects', async () => {
    let conn = connectAutoAck();
    await conn.welcome;

    // Ingest 100 messages, cycling the connection every 20.
    for (let i = 0; i < 100; i++) {
      await router.ingestInbound({
        adapter: 'fake',
        sessionId: 'ss',
        senderId: 'u',
        content: `m${i}`,
        meta: {},
        files: [],
        idempotencyKey: `k:${i}`,
        receivedAt: new Date(),
      });
      if (i > 0 && i % 20 === 0) {
        conn.destroy();
        await new Promise((r) => setTimeout(r, 100));
        conn = connectAutoAck();
        await conn.welcome;
      }
    }

    // Wait for full drain (reconnect flush).
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const row = db.raw
        .prepare(`SELECT COUNT(*) AS c FROM inbound_messages WHERE state = 'acknowledged'`)
        .get() as { c: number };
      if (row.c === 100) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const rows = db.raw.prepare('SELECT COUNT(*) AS c FROM inbound_messages').get() as {
      c: number;
    };
    const ackedCount = db.raw
      .prepare(`SELECT COUNT(*) AS c FROM inbound_messages WHERE state = 'acknowledged'`)
      .get() as { c: number };
    expect(rows.c).toBe(100);
    expect(ackedCount.c).toBe(100);

    conn.destroy();
  }, 20_000);
});
