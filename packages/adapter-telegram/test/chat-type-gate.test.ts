import { describe, it, expect, afterEach } from 'vitest';
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
import { createBinding } from '../../core/src/pairing.js';
import type { AdapterContext, InboundMessage } from '../../core/src/adapter.js';
import { TelegramAdapter } from '../src/index.js';
import { FakeTelegramTransport } from './fake-transport.js';

let dir: string;
let db: DatabaseHandle;
let router: Router;
let ipcServer: IpcServer;
let adapter: TelegramAdapter;
let fake: FakeTelegramTransport;
let ingested: InboundMessage[];
let permissionVerdicts: Array<{ requestId: string; behavior: 'allow' | 'deny' }>;

interface BootOptions {
  allowGroups?: boolean;
  mode?: 'pairing' | 'allowlist';
  allowlist?: string[];
}

async function bootAdapter(opts: BootOptions = {}): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'reder-tg-chat-type-test-'));
  db = openDatabase(join(dir, 'test.db'));
  await createSession(db.raw, 'booknerds', 'BookNerds');
  const socketPath = join(dir, 'reder.sock');
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  const audit = createAuditLog(dir);
  ipcServer = await createIpcServer({ db: db.raw, socketPath, logger });
  router = createRouter({ db: db.raw, ipcServer, logger, audit });

  fake = new FakeTelegramTransport();
  ingested = [];
  permissionVerdicts = [];

  // Spy on router.ingestInbound to detect any update that slipped past the gate.
  const origIngest = router.ingestInbound.bind(router);
  router.ingestInbound = async (msg: InboundMessage): Promise<void> => {
    ingested.push(msg);
    return origIngest(msg);
  };

  // Spy on router.ingestPermissionVerdict so we can assert callback queries
  // from group chats never reach it.
  const origVerdict = router.ingestPermissionVerdict.bind(router);
  router.ingestPermissionVerdict = async (v): Promise<void> => {
    permissionVerdicts.push({ requestId: v.requestId, behavior: v.behavior });
    return origVerdict(v);
  };

  adapter = new TelegramAdapter({ transportFactory: () => fake });
  const botConfig: Record<string, unknown> = { token: 'fake-token', session_id: 'booknerds' };
  if (opts.allowGroups !== undefined) botConfig['allow_groups'] = opts.allowGroups;

  const config: Record<string, unknown> = {
    bots: [botConfig],
    long_poll_timeout_seconds: 1,
  };
  if (opts.mode !== undefined) config['mode'] = opts.mode;
  if (opts.allowlist !== undefined) config['allowlist'] = opts.allowlist;

  const ctx: AdapterContext = {
    logger: logger.child({ component: 'adapter.telegram' }),
    config,
    storage: createAdapterStorage(db.raw, 'telegram'),
    router,
    dataDir: dir,
    sessions: [],
  };
  await adapter.start(ctx);
  router.registerAdapter('telegram', { adapter });
}

afterEach(async () => {
  await adapter.stop();
  await ipcServer.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('TelegramAdapter chat-type gate (allow_groups)', () => {
  it('drops group-chat updates silently when allow_groups is the default (false)', async () => {
    await bootAdapter({ mode: 'allowlist', allowlist: ['99'] });

    fake.enqueueText({
      update_id: 1,
      chatId: -1001,
      senderId: 99,
      text: 'leak my secrets',
      chatType: 'group',
    });

    // Give the poll loop multiple ticks.
    await new Promise((r) => setTimeout(r, 100));

    expect(ingested).toHaveLength(0);
    // Silent drop: no reply, no warning sent back to the chat.
    expect(fake.sent).toHaveLength(0);
  });

  it('drops supergroup-chat updates silently when allow_groups is false', async () => {
    await bootAdapter({ mode: 'allowlist', allowlist: ['99'] });

    fake.enqueueText({
      update_id: 1,
      chatId: -100200,
      senderId: 99,
      text: 'still no',
      chatType: 'supergroup',
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(ingested).toHaveLength(0);
    expect(fake.sent).toHaveLength(0);
  });

  it('drops channel posts silently when allow_groups is false', async () => {
    await bootAdapter({ mode: 'allowlist', allowlist: ['99'] });

    fake.enqueueText({
      update_id: 1,
      chatId: -100300,
      senderId: 99,
      text: 'broadcasting...',
      chatType: 'channel',
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(ingested).toHaveLength(0);
    expect(fake.sent).toHaveLength(0);
  });

  it('lets private-chat updates through normally with the default allow_groups: false', async () => {
    await bootAdapter({ mode: 'allowlist', allowlist: ['99'] });

    fake.enqueueText({
      update_id: 1,
      chatId: 42,
      senderId: 99,
      text: 'hi',
      chatType: 'private',
    });

    await waitFor(() => ingested.length > 0, 2000);

    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toMatchObject({
      adapter: 'telegram',
      sessionId: 'booknerds',
      senderId: '99',
      content: 'hi',
    });
  });

  it('processes group updates when allow_groups is explicitly set to true', async () => {
    await bootAdapter({ mode: 'allowlist', allowlist: ['99'], allowGroups: true });

    fake.enqueueText({
      update_id: 1,
      chatId: -1001,
      senderId: 99,
      text: 'group is fine here',
      chatType: 'group',
    });

    await waitFor(() => ingested.length > 0, 2000);

    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.content).toBe('group is fine here');
  });

  it('drops callback queries from group chats when allow_groups is false', async () => {
    await bootAdapter({ mode: 'allowlist', allowlist: ['99'] });

    // Pre-bind sender 99 so the access gate would otherwise pass.
    createBinding(db.raw, {
      adapter: 'telegram',
      senderId: '99',
      sessionId: 'booknerds',
      metadata: { chat_id: '42' },
    });

    fake.enqueueCallbackQuery({
      update_id: 1,
      id: 'cb-1',
      chatId: -1001,
      messageId: 555,
      senderId: 99,
      data: 'perm:req-1:allow',
      chatType: 'group',
    });

    await new Promise((r) => setTimeout(r, 100));

    // The callback was never answered: gate dropped it before any
    // response was issued (preventing a verdict leak in the group).
    expect(fake.callbackAnswers).toHaveLength(0);
    expect(permissionVerdicts).toHaveLength(0);
  });

  it('processes private callback queries normally with allow_groups: false', async () => {
    await bootAdapter({ mode: 'allowlist', allowlist: ['99'] });

    createBinding(db.raw, {
      adapter: 'telegram',
      senderId: '99',
      sessionId: 'booknerds',
      metadata: { chat_id: '42' },
    });

    fake.enqueueCallbackQuery({
      update_id: 1,
      id: 'cb-1',
      chatId: 42,
      messageId: 555,
      senderId: 99,
      data: 'perm:req-1:allow',
      chatType: 'private',
    });

    await waitFor(() => fake.callbackAnswers.length > 0, 2000);

    expect(fake.callbackAnswers).toHaveLength(1);
    expect(fake.callbackAnswers[0]?.id).toBe('cb-1');
  });
});
