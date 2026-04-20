import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DatabaseHandle } from '../../core/src/storage/db.js';
import { createSession } from '../../core/src/sessions.js';
import { createLogger } from '../../core/src/logger.js';
import { createAuditLog } from '../../core/src/audit.js';
import { createIpcServer, type IpcServer } from '../../core/src/ipc/server.js';
import { createRouter, type Router } from '../../core/src/router.js';
import { createAdapterStorage } from '../../core/src/storage/kv.js';
import type { AdapterContext, InboundMessage } from '../../core/src/adapter.js';
import { TelegramAdapter } from '../src/index.js';
import { FakeTelegramTransport } from './fake-transport.js';

let dir: string;
let db: DatabaseHandle;
let router: Router;
let ipcServer: IpcServer;
let adapter: TelegramAdapter;
let fake: FakeTelegramTransport;
let received: InboundMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-tg-test-'));
  db = openDatabase(join(dir, 'test.db'));
  await createSession(db.raw, 'booknerds', 'BookNerds');
  const socketPath = join(dir, 'reder.sock');
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  const audit = createAuditLog(dir);
  ipcServer = await createIpcServer({ db: db.raw, socketPath, logger });
  router = createRouter({ db: db.raw, ipcServer, logger, audit });

  fake = new FakeTelegramTransport({ botId: 42, botUsername: 'booknerds_bot' });
  received = [];

  // Capture inbound by spying on router.ingestInbound
  const originalIngest = router.ingestInbound.bind(router);
  router.ingestInbound = async (msg: InboundMessage): Promise<void> => {
    received.push(msg);
    return originalIngest(msg);
  };

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

describe('TelegramAdapter inbound', () => {
  it('forwards a text message to the router as InboundMessage', async () => {
    fake.enqueueText({ update_id: 1, chatId: 100, senderId: 5, text: 'hello world' });
    await waitFor(() => received.length > 0, 2000);
    expect(received[0]).toMatchObject({
      adapter: 'telegram',
      sessionId: 'booknerds',
      senderId: '5',
      content: 'hello world',
    });
    expect(received[0]!.meta['chat_id']).toBe('100');
  });

  it('advances the offset only after router ingest', async () => {
    fake.enqueueText({ update_id: 10, chatId: 1, senderId: 2, text: 'a' });
    await waitFor(() => received.length > 0, 2000);
    const stored = await createAdapterStorage(db.raw, 'telegram').get('offset:booknerds');
    expect(stored?.toString('utf8')).toBe('11');
  });

  it('dedupes repeated deliveries of the same update_id via idempotency_key', async () => {
    fake.enqueueText({ update_id: 1, chatId: 1, senderId: 2, text: 'once', messageId: 99 });
    await waitFor(() => received.length > 0, 2000);
    fake.enqueueText({ update_id: 1, chatId: 1, senderId: 2, text: 'once', messageId: 99 });
    await new Promise((r) => setTimeout(r, 100));
    const rows = db.raw.prepare('SELECT COUNT(*) AS c FROM inbound_messages').get() as {
      c: number;
    };
    expect(rows.c).toBe(1);
  });

  it('ignores non-text non-handled messages silently', async () => {
    fake.enqueueUpdate({
      update_id: 5,
      message: {
        message_id: 200,
        chat: { id: 1, type: 'private' },
        from: { id: 1 },
        date: 1,
        document: { file_id: 'doc1' },
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    // No router call (documents are Milestone 9)
    expect(received).toHaveLength(0);
  });

  it('replies to voice notes with a not-yet-supported message', async () => {
    fake.enqueueUpdate({
      update_id: 7,
      message: {
        message_id: 300,
        chat: { id: 1, type: 'private' },
        from: { id: 1 },
        date: 1,
        voice: { file_id: 'v1', duration: 3 },
      },
    });
    await waitFor(() => fake.sent.length > 0, 2000);
    expect(fake.sent[0]!.text).toContain('Voice notes');
  });
});

describe('TelegramAdapter outbound', () => {
  it('renders and sends a reply via the bot bound to the session', async () => {
    const result = await adapter.sendOutbound({
      sessionId: 'booknerds',
      adapter: 'telegram',
      recipient: '42',
      content: 'Hello! **Great** to hear from you.',
      meta: {},
      files: [],
    });
    expect(result.success).toBe(true);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.text).toContain('*Great*');
    expect(fake.sent[0]!.opts?.parse_mode).toBe('MarkdownV2');
  });

  it('splits long replies across multiple messages', async () => {
    const long = 'x'.repeat(8000);
    const result = await adapter.sendOutbound({
      sessionId: 'booknerds',
      adapter: 'telegram',
      recipient: '42',
      content: long,
      meta: {},
      files: [],
    });
    expect(result.success).toBe(true);
    expect(fake.sent.length).toBeGreaterThan(1);
  });

  it('returns non-retriable failure for unknown session', async () => {
    const result = await adapter.sendOutbound({
      sessionId: 'unknown-session',
      adapter: 'telegram',
      recipient: '42',
      content: 'hi',
      meta: {},
      files: [],
    });
    expect(result.success).toBe(false);
    expect(result.retriable).toBe(false);
  });

  it('classifies 429 rate limit errors as retriable', async () => {
    fake.failNextSend(new Error('429 Too Many Requests'), 1);
    const result = await adapter.sendOutbound({
      sessionId: 'booknerds',
      adapter: 'telegram',
      recipient: '42',
      content: 'hi',
      meta: {},
      files: [],
    });
    expect(result.success).toBe(false);
    expect(result.retriable).toBe(true);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
