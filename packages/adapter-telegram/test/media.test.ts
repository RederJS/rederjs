import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
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
import { downloadAndCache, FileTooLargeError } from '../src/media.js';
import { FakeTelegramTransport } from './fake-transport.js';

let dir: string;
let db: DatabaseHandle;
let router: Router;
let ipcServer: IpcServer;
let adapter: TelegramAdapter;
let fake: FakeTelegramTransport;
let received: InboundMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-tg-media-test-'));
  db = openDatabase(join(dir, 'test.db'));
  await createSession(db.raw, 'booknerds', 'BookNerds');
  const socketPath = join(dir, 'reder.sock');
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  const audit = createAuditLog(dir);
  ipcServer = await createIpcServer({ db: db.raw, socketPath, logger });
  router = createRouter({ db: db.raw, ipcServer, logger, audit });

  fake = new FakeTelegramTransport();
  received = [];
  const orig = router.ingestInbound.bind(router);
  router.ingestInbound = async (m) => {
    received.push(m);
    return orig(m);
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
    sessions: [],
  };
  await adapter.start(ctx);
  router.registerAdapter('telegram', { adapter });

  createBinding(db.raw, {
    adapter: 'telegram',
    senderId: '99',
    sessionId: 'booknerds',
    metadata: { chat_id: '42' },
  });
});

afterEach(async () => {
  await adapter.stop();
  await ipcServer.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('downloadAndCache', () => {
  it('caches file under sha256 name and enforces max size', async () => {
    fake.files.set('f1', { file_path: 'photos/abc.jpg', data: Buffer.from('hello world') });
    const cached = await downloadAndCache({
      transport: fake,
      fileId: 'f1',
      cacheDir: join(dir, 'cache'),
    });
    expect(cached.path.endsWith('.jpg')).toBe(true);
    expect(readFileSync(cached.path, 'utf8')).toBe('hello world');
    const mode = statSync(cached.path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('throws FileTooLargeError when payload exceeds limit', async () => {
    fake.files.set('f2', { file_path: 'x.bin', data: Buffer.alloc(100) });
    await expect(
      downloadAndCache({
        transport: fake,
        fileId: 'f2',
        cacheDir: join(dir, 'cache'),
        maxBytes: 10,
      }),
    ).rejects.toBeInstanceOf(FileTooLargeError);
  });
});

describe('TelegramAdapter media', () => {
  it('downloads a photo, caches it, and emits InboundMessage with files[] + image_path meta', async () => {
    fake.files.set('ph1', { file_path: 'photos/a.jpg', data: Buffer.from('image-bytes') });
    fake.enqueueUpdate({
      update_id: 1,
      message: {
        message_id: 101,
        chat: { id: 42, type: 'private' },
        from: { id: 99 },
        date: 1,
        photo: [
          { file_id: 'ph1-small', width: 100, height: 100, file_size: 100 },
          { file_id: 'ph1', width: 800, height: 600, file_size: 12345 },
        ],
        caption: 'look at this',
      },
    });
    await waitFor(() => received.length > 0, 2000);
    expect(received[0]!.content).toBe('look at this');
    expect(received[0]!.files).toHaveLength(1);
    expect(received[0]!.meta['image_path']).toBe(received[0]!.files[0]);
    expect(received[0]!.meta['attachment_kind']).toBe('image');
  });

  it('downloads a document and emits InboundMessage with file_path meta', async () => {
    fake.files.set('doc1', { file_path: 'docs/report.pdf', data: Buffer.from('%PDF-1.4\n...') });
    fake.enqueueUpdate({
      update_id: 1,
      message: {
        message_id: 200,
        chat: { id: 42, type: 'private' },
        from: { id: 99 },
        date: 1,
        document: {
          file_id: 'doc1',
          file_name: 'report.pdf',
          mime_type: 'application/pdf',
          file_size: 13,
        },
      },
    });
    await waitFor(() => received.length > 0, 2000);
    expect(received[0]!.meta['file_path']).toBeTruthy();
    expect(received[0]!.meta['attachment_name']).toBe('report.pdf');
    expect(received[0]!.meta['attachment_mime']).toBe('application/pdf');
  });

  it('rejects documents larger than 20 MB', async () => {
    fake.enqueueUpdate({
      update_id: 1,
      message: {
        message_id: 300,
        chat: { id: 42, type: 'private' },
        from: { id: 99 },
        date: 1,
        document: {
          file_id: 'big',
          file_size: 21 * 1024 * 1024,
        },
      },
    });
    await waitFor(() => fake.sent.length > 0, 2000);
    expect(fake.sent[0]!.text).toContain('too large');
    expect(received).toHaveLength(0);
  });

  it('voice note reply does not forward to router', async () => {
    fake.enqueueUpdate({
      update_id: 1,
      message: {
        message_id: 400,
        chat: { id: 42, type: 'private' },
        from: { id: 99 },
        date: 1,
        voice: { file_id: 'v1', duration: 3 },
      },
    });
    await waitFor(() => fake.sent.length > 0, 2000);
    expect(fake.sent[0]!.text).toContain('Voice notes');
    expect(received).toHaveLength(0);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
