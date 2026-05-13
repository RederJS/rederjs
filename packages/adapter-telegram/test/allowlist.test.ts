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
import { getBinding } from '../../core/src/pairing.js';
import type { AdapterContext } from '../../core/src/adapter.js';
import { TelegramAdapter } from '../src/index.js';
import { FakeTelegramTransport } from './fake-transport.js';

let dir: string;
let db: DatabaseHandle;
let router: Router;
let ipcServer: IpcServer;
let adapter: TelegramAdapter;
let fake: FakeTelegramTransport;

async function bootAdapter(config: Record<string, unknown>): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'reder-tg-allow-test-'));
  db = openDatabase(join(dir, 'test.db'));
  await createSession(db.raw, 'booknerds', 'BookNerds');
  const socketPath = join(dir, 'reder.sock');
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  const audit = createAuditLog(dir);
  ipcServer = await createIpcServer({ db: db.raw, socketPath, logger });
  router = createRouter({ db: db.raw, ipcServer, logger, audit });

  fake = new FakeTelegramTransport();
  adapter = new TelegramAdapter({ transportFactory: () => fake });
  const ctx: AdapterContext = {
    logger: logger.child({ component: 'adapter.telegram' }),
    config: {
      bots: [{ token: 'fake-token', session_id: 'booknerds' }],
      long_poll_timeout_seconds: 1,
      ...config,
    },
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

describe('TelegramAdapter allowlist mode', () => {
  it('ingests messages from allowlisted senders without pairing', async () => {
    await bootAdapter({ mode: 'allowlist', allowlist: ['99'] });

    const ingested: unknown[] = [];
    const orig = router.ingestInbound.bind(router);
    router.ingestInbound = async (m) => {
      ingested.push(m);
      return orig(m);
    };

    fake.enqueueText({ update_id: 1, chatId: 42, senderId: 99, text: 'hi' });
    await waitFor(() => ingested.length > 0, 2000);

    expect(ingested).toHaveLength(1);
    // No pair-code DM was sent.
    const pairMsgs = fake.sent.filter((s) => s.text.toLowerCase().includes('pairing'));
    expect(pairMsgs).toHaveLength(0);
    // No pair_codes row was created.
    const pairRows = db.raw.prepare('SELECT id FROM pair_codes_v2').all();
    expect(pairRows).toHaveLength(0);
    // Binding was auto-created with chat_id metadata.
    const binding = getBinding(db.raw, 'telegram', '99', 'booknerds');
    expect(binding).not.toBeNull();
    expect(binding?.metadata?.['chat_id']).toBe('42');
  });

  it('silently drops messages from non-allowlisted senders', async () => {
    await bootAdapter({ mode: 'allowlist', allowlist: ['99'] });

    const ingested: unknown[] = [];
    const orig = router.ingestInbound.bind(router);
    router.ingestInbound = async (m) => {
      ingested.push(m);
      return orig(m);
    };

    fake.enqueueText({ update_id: 1, chatId: 7, senderId: 1234, text: 'hi' });
    // Give the poll loop a couple of ticks.
    await new Promise((r) => setTimeout(r, 100));

    expect(ingested).toHaveLength(0);
    expect(fake.sent).toHaveLength(0);
    const pairRows = db.raw.prepare('SELECT id FROM pair_codes_v2').all();
    expect(pairRows).toHaveLength(0);
    const binding = getBinding(db.raw, 'telegram', '1234', 'booknerds');
    expect(binding).toBeNull();
  });

  it('pairing mode remains the default and still emits pair codes', async () => {
    // No `mode` field in config → schema default = 'pairing'.
    await bootAdapter({});

    fake.enqueueText({ update_id: 1, chatId: 42, senderId: 99, text: 'hi' });
    await waitFor(() => fake.sent.length > 0, 2000);

    expect(fake.sent[0]!.text).toContain('pairing code');
    const pairRows = db.raw.prepare('SELECT id FROM pair_codes_v2').all() as Array<{ id: Buffer }>;
    expect(pairRows).toHaveLength(1);
  });
});
