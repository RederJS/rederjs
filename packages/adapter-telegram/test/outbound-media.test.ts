import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendOutboundWithFiles } from '../src/outbound-media.js';
import { FakeTelegramTransport } from './fake-transport.js';
import type { AttachmentRef } from '@rederjs/core/media';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-tg-out-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeRef(extLabel: string, mime: string, kind: 'image' | 'document'): AttachmentRef {
  // Construct a deterministic 64-hex sha and a real file in the temp dir.
  const sha = ('a'.repeat(63) + extLabel.charCodeAt(1).toString(16)).slice(0, 64);
  const filename = `${sha}${extLabel}`;
  const p = join(dir, filename);
  writeFileSync(p, Buffer.from('x'));
  return {
    path: p,
    mime,
    name: 'file' + extLabel,
    kind,
    size: 1,
    sha256: sha,
  };
}

describe('sendOutboundWithFiles', () => {
  it('single image → sendPhoto with caption', async () => {
    const fake = new FakeTelegramTransport();
    const ref = makeRef('.png', 'image/png', 'image');
    const result = await sendOutboundWithFiles({
      transport: fake,
      chatId: 42,
      content: 'hi',
      refs: [ref],
      mediaCachePrefix: dir,
    });
    expect(result.success).toBe(true);
    expect(fake.sentPhotos).toHaveLength(1);
    expect(fake.sentPhotos[0]!.opts?.caption).toBe('hi');
    expect(fake.sentDocuments).toHaveLength(0);
    expect(fake.sentGroups).toHaveLength(0);
  });

  it('two images → sendMediaGroup with caption on first item', async () => {
    const fake = new FakeTelegramTransport();
    const refs = [
      makeRef('.png', 'image/png', 'image'),
      makeRef('.jpg', 'image/jpeg', 'image'),
    ];
    const result = await sendOutboundWithFiles({
      transport: fake,
      chatId: 42,
      content: 'two pics',
      refs,
      mediaCachePrefix: dir,
    });
    expect(result.success).toBe(true);
    expect(fake.sentGroups).toHaveLength(1);
    expect(fake.sentGroups[0]!.media[0]!.caption).toBe('two pics');
    expect(fake.sentGroups[0]!.media[1]!.caption).toBeUndefined();
  });

  it('mixed batch → image group first (with caption), then docs without caption', async () => {
    const fake = new FakeTelegramTransport();
    const refs = [
      makeRef('.png', 'image/png', 'image'),
      makeRef('.jpg', 'image/jpeg', 'image'),
      makeRef('.pdf', 'application/pdf', 'document'),
    ];
    const result = await sendOutboundWithFiles({
      transport: fake,
      chatId: 42,
      content: 'see',
      refs,
      mediaCachePrefix: dir,
    });
    expect(result.success).toBe(true);
    expect(fake.sentGroups).toHaveLength(1);
    expect(fake.sentGroups[0]!.media[0]!.caption).toBe('see');
    expect(fake.sentDocuments).toHaveLength(1);
    expect(fake.sentDocuments[0]!.opts?.caption).toBeUndefined();
  });

  it('mixed batch with single image → sendPhoto first then sendDocument', async () => {
    const fake = new FakeTelegramTransport();
    const refs = [
      makeRef('.png', 'image/png', 'image'),
      makeRef('.pdf', 'application/pdf', 'document'),
    ];
    const result = await sendOutboundWithFiles({
      transport: fake,
      chatId: 42,
      content: 'cap',
      refs,
      mediaCachePrefix: dir,
    });
    expect(result.success).toBe(true);
    expect(fake.sentPhotos).toHaveLength(1);
    expect(fake.sentPhotos[0]!.opts?.caption).toBe('cap');
    expect(fake.sentDocuments).toHaveLength(1);
    expect(fake.sentDocuments[0]!.opts?.caption).toBeUndefined();
  });

  it('all-docs → first sendDocument carries caption', async () => {
    const fake = new FakeTelegramTransport();
    const refs = [
      makeRef('.pdf', 'application/pdf', 'document'),
      makeRef('.txt', 'text/plain', 'document'),
    ];
    const result = await sendOutboundWithFiles({
      transport: fake,
      chatId: 42,
      content: 'docs',
      refs,
      mediaCachePrefix: dir,
    });
    expect(result.success).toBe(true);
    expect(fake.sentDocuments).toHaveLength(2);
    expect(fake.sentDocuments[0]!.opts?.caption).toBe('docs');
    expect(fake.sentDocuments[1]!.opts?.caption).toBeUndefined();
  });

  it('rejects paths outside the media cache prefix', async () => {
    const fake = new FakeTelegramTransport();
    const ref: AttachmentRef = {
      path: '/etc/passwd',
      mime: 'text/plain',
      name: 'passwd',
      kind: 'document',
      size: 1,
      sha256: 'a'.repeat(64),
    };
    const result = await sendOutboundWithFiles({
      transport: fake,
      chatId: 42,
      content: 'leak',
      refs: [ref],
      mediaCachePrefix: dir,
    });
    expect(result.success).toBe(false);
    expect(result.retriable).toBe(false);
    expect(fake.sentDocuments).toHaveLength(0);
  });

  it('truncates captions over 1024 chars', async () => {
    const fake = new FakeTelegramTransport();
    const ref = makeRef('.png', 'image/png', 'image');
    const long = 'x'.repeat(2000);
    const result = await sendOutboundWithFiles({
      transport: fake,
      chatId: 42,
      content: long,
      refs: [ref],
      mediaCachePrefix: dir,
    });
    expect(result.success).toBe(true);
    const cap = fake.sentPhotos[0]!.opts?.caption;
    expect(cap).toBeDefined();
    expect(cap!.length).toBeLessThanOrEqual(1024);
    expect(cap!.endsWith('…')).toBe(true);
  });

  it('all sends fail → success: false with retriable inferred from last error', async () => {
    const fake = new FakeTelegramTransport();
    fake.failNextSend(new Error('Telegram 503'), 5);
    // Force the failure injection to apply to sendPhoto by using a single image.
    const ref = makeRef('.png', 'image/png', 'image');
    const result = await sendOutboundWithFiles({
      transport: fake,
      chatId: 42,
      content: 'fail',
      refs: [ref],
      mediaCachePrefix: dir,
    });
    expect(result.success).toBe(false);
    expect(result.retriable).toBe(true);
    expect(result.error).toContain('503');
  });
});
