import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DatabaseHandle } from '../../../core/src/storage/db.js';
import { createSession } from '../../../core/src/sessions.js';
import { createLogger } from '../../../core/src/logger.js';
import { createAuditLog } from '../../../core/src/audit.js';
import { createIpcServer, type IpcServer } from '../../../core/src/ipc/server.js';
import { createRouter, type Router } from '../../../core/src/router.js';
import { createAdapterStorage } from '../../../core/src/storage/kv.js';
import { createBinding } from '../../../core/src/pairing.js';
import type { AdapterContext, InboundMessage } from '../../../core/src/adapter.js';
import { TelegramAdapter } from '../../src/index.js';
import { FakeTelegramTransport } from '../fake-transport.js';

let dir: string;
let db: DatabaseHandle;
let router: Router;
let ipcServer: IpcServer;
let adapter: TelegramAdapter;
let fake: FakeTelegramTransport;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-chaos-net-'));
  db = openDatabase(join(dir, 'test.db'));
  await createSession(db.raw, 'booknerds', 'BookNerds');
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  const audit = createAuditLog(dir);
  ipcServer = await createIpcServer({
    db: db.raw,
    socketPath: join(dir, 'reder.sock'),
    logger,
  });
  router = createRouter({ db: db.raw, ipcServer, logger, audit });

  fake = new FakeTelegramTransport({ longPollTick: 5 });
  adapter = new TelegramAdapter({
    transportFactory: () => fake,
    rateLimitPerMinute: 10_000,
  });
  const ctx: AdapterContext = {
    logger: logger.child({ component: 'adapter.telegram' }),
    config: {
      bots: [{ token: 'x', session_id: 'booknerds' }],
      long_poll_timeout_seconds: 1,
    },
    storage: createAdapterStorage(db.raw, 'telegram'),
    router,
    dataDir: dir,
    sessions: [],
  };
  await adapter.start(ctx);
  router.registerAdapter('telegram', { adapter });
  createBinding(db.raw, {
    adapter: 'telegram',
    senderId: '7',
    sessionId: 'booknerds',
    metadata: { chat_id: '777' },
  });
});

afterEach(async () => {
  await adapter.stop();
  await ipcServer.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('NFR-R1: Telegram network drop', () => {
  it('delivers all 100 messages queued during a simulated network drop', async () => {
    const ingested: InboundMessage[] = [];
    const orig = router.ingestInbound.bind(router);
    router.ingestInbound = async (m) => {
      ingested.push(m);
      return orig(m);
    };

    // Drop the connection for 1200 ms (compressed proxy for the PRD's 30 min).
    fake.goDown(1200);

    // Enqueue 100 messages during the drop.
    for (let i = 1; i <= 100; i++) {
      fake.enqueueText({
        update_id: i,
        chatId: 777,
        senderId: 7,
        text: `m${i}`,
        messageId: i,
      });
    }

    // Wait for all 100 to arrive after connection restoration.
    const deadline = Date.now() + 10_000;
    while (ingested.length < 100 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(ingested.length).toBe(100);
    // Assert in-order delivery (by update_id encoded in text).
    const order = ingested.map((m) => Number(m.content.slice(1)));
    for (let i = 0; i < order.length; i++) {
      expect(order[i]).toBe(i + 1);
    }
  }, 15_000);
});
