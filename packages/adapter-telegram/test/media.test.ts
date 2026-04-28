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
import { createBinding } from '../../core/src/pairing.js';
import type { AdapterContext, InboundMessage } from '../../core/src/adapter.js';
import { TelegramAdapter } from '../src/index.js';
import { decodeAttachmentsMeta, mediaDirFor } from '../../core/src/media.js';
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

describe('TelegramAdapter media (per-session cache + meta.attachments)', () => {
  it('caches a photo under sessions/<id>/<sha256>.<ext>', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    fake.files.set('ph1', { file_path: 'photos/a.jpg', data: png });
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
        caption: 'look',
      },
    });
    await waitFor(() => received.length > 0, 2000);
    const m = received[0]!;
    expect(m.content).toBe('look');
    expect(m.files).toHaveLength(1);
    expect(m.files[0]!.startsWith(mediaDirFor(dir, 'booknerds'))).toBe(true);
    const refs = decodeAttachmentsMeta(m.meta['attachments']);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.kind).toBe('image');
    expect(refs[0]!.mime).toBe('image/png');
    expect(m.meta['image_path']).toBeUndefined();
    expect(m.meta['attachment_kind']).toBeUndefined();
  });

  it('caches a PDF document with meta.attachments and no legacy keys', async () => {
    const pdf = Buffer.from('%PDF-1.4\nhi\n');
    fake.files.set('doc1', { file_path: 'docs/r.pdf', data: pdf });
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
          file_size: pdf.length,
        },
      },
    });
    await waitFor(() => received.length > 0, 2000);
    const refs = decodeAttachmentsMeta(received[0]!.meta['attachments']);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.kind).toBe('document');
    expect(refs[0]!.mime).toBe('application/pdf');
    expect(refs[0]!.name).toBe('report.pdf');
    expect(received[0]!.meta['file_path']).toBeUndefined();
  });

  it('rejects oversized documents before downloading', async () => {
    fake.enqueueUpdate({
      update_id: 1,
      message: {
        message_id: 300,
        chat: { id: 42, type: 'private' },
        from: { id: 99 },
        date: 1,
        document: { file_id: 'big', file_size: 21 * 1024 * 1024 },
      },
    });
    await waitFor(() => fake.sent.length > 0, 2000);
    expect(fake.sent[0]!.text).toContain('too large');
    expect(received).toHaveLength(0);
  });

  it('rejects an unsupported document MIME with a friendly reply', async () => {
    // ZIP magic bytes — not in our 7-MIME allowlist, sniffer returns undefined.
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    fake.files.set('zip1', { file_path: 'docs/x.zip', data: zip });
    fake.enqueueUpdate({
      update_id: 1,
      message: {
        message_id: 350,
        chat: { id: 42, type: 'private' },
        from: { id: 99 },
        date: 1,
        document: {
          file_id: 'zip1',
          file_name: 'archive.zip',
          mime_type: 'application/zip',
          file_size: zip.length,
        },
      },
    });
    await waitFor(() => fake.sent.length > 0, 2000);
    expect(fake.sent[0]!.text.toLowerCase()).toContain('not supported');
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

describe('TelegramAdapter outbound files', () => {
  it('sendOutbound delegates to sendOutboundWithFiles when files present', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xab, 0xcd]);
    fake.files.set('phX', { file_path: 'p.png', data: png });

    // Stage a file via the inbound flow so we have a valid path under
    // <dataDir>/media/sessions/booknerds/.
    fake.enqueueUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 42, type: 'private' },
        from: { id: 99 },
        date: 1,
        photo: [{ file_id: 'phX', width: 10, height: 10, file_size: 12345 }],
        caption: 'incoming',
      },
    });
    await waitFor(() => received.length > 0, 2000);
    const stagedPath = received[0]!.files[0]!;
    const stagedAttachmentsMeta = received[0]!.meta['attachments']!;

    // Now ask the adapter to send the same path back outbound.
    const result = await adapter.sendOutbound({
      sessionId: 'booknerds',
      adapter: 'telegram',
      recipient: '42',
      content: 'reply with image',
      meta: { attachments: stagedAttachmentsMeta },
      files: [stagedPath],
    });
    expect(result.success).toBe(true);
    expect(fake.sentPhotos).toHaveLength(1);
    expect(fake.sentPhotos[0]!.opts?.caption).toBe('reply with image');
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
