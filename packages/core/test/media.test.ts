import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  sniffMime,
  encodeAttachmentsMeta,
  decodeAttachmentsMeta,
  cacheInboundBlob,
  stageOutboundFile,
  mediaDirFor,
  wipeMediaForSession,
  PER_FILE_MAX_BYTES,
} from '../src/media.js';
import type { AttachmentRef } from '../src/media.js';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('sniffMime', () => {
  it('detects PNG from 8-byte signature', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);
    expect(sniffMime(png, undefined, undefined)).toBe('image/png');
  });

  it('detects JPEG from FFD8FF prefix', () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    expect(sniffMime(jpg, undefined, undefined)).toBe('image/jpeg');
  });

  it('detects GIF87a and GIF89a', () => {
    const a = Buffer.from('GIF87a' + '\0\0\0', 'binary');
    const b = Buffer.from('GIF89a' + '\0\0\0', 'binary');
    expect(sniffMime(a, undefined, undefined)).toBe('image/gif');
    expect(sniffMime(b, undefined, undefined)).toBe('image/gif');
  });

  it('detects WebP from RIFF...WEBP layout', () => {
    const buf = Buffer.alloc(16);
    buf.write('RIFF', 0, 'ascii');
    buf.write('WEBP', 8, 'ascii');
    expect(sniffMime(buf, undefined, undefined)).toBe('image/webp');
  });

  it('detects PDF from %PDF- prefix', () => {
    expect(sniffMime(Buffer.from('%PDF-1.7\n'), undefined, undefined)).toBe('application/pdf');
  });

  it('returns text/markdown for utf-8 text when name has .md', () => {
    expect(sniffMime(Buffer.from('# hello\n'), undefined, 'README.md')).toBe('text/markdown');
  });

  it('returns text/plain for utf-8 text without a recognized extension', () => {
    expect(sniffMime(Buffer.from('plain text body\n'), undefined, 'notes')).toBe('text/plain');
  });

  it('returns text/plain when name ends in .txt', () => {
    expect(sniffMime(Buffer.from('plain text\n'), undefined, 'log.txt')).toBe('text/plain');
  });

  it('returns undefined for binary blobs that are neither known nor text', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(sniffMime(buf, undefined, 'mystery.bin')).toBeUndefined();
  });

  it('rejects text-looking content with NUL bytes', () => {
    const buf = Buffer.from('hello\0world\n');
    expect(sniffMime(buf, undefined, 'mystery.txt')).toBeUndefined();
  });

  it('does not trust declared mime — magic bytes win', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffMime(png, 'application/pdf', 'fake.pdf')).toBe('image/png');
  });
});

describe('encode/decodeAttachmentsMeta', () => {
  const refs: AttachmentRef[] = [
    {
      path: '/data/media/sessions/s1/aaaa.png',
      mime: 'image/png',
      name: 'one.png',
      kind: 'image',
      size: 100,
      sha256: 'a'.repeat(64),
    },
    {
      path: '/data/media/sessions/s1/bbbb.pdf',
      mime: 'application/pdf',
      name: 'two.pdf',
      kind: 'document',
      size: 200,
      sha256: 'b'.repeat(64),
    },
  ];

  it('round-trips through encode/decode', () => {
    const json = encodeAttachmentsMeta(refs);
    expect(typeof json).toBe('string');
    expect(decodeAttachmentsMeta(json)).toEqual(refs);
  });

  it('returns [] for absent / undefined input', () => {
    expect(decodeAttachmentsMeta(undefined)).toEqual([]);
    expect(decodeAttachmentsMeta('')).toEqual([]);
  });

  it('drops invalid entries silently', () => {
    expect(decodeAttachmentsMeta('not-json')).toEqual([]);
    expect(decodeAttachmentsMeta('{"not":"array"}')).toEqual([]);
    expect(decodeAttachmentsMeta('[{"path":"/x"}]')).toEqual([]); // missing required keys
  });

  it('encode emits an empty string when given no refs', () => {
    expect(encodeAttachmentsMeta([])).toBe('');
  });
});

describe('cacheInboundBlob', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reder-media-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes bytes under sessions/<id>/<sha256>.<ext> with 0600', async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04,
    ]);
    const ref = await cacheInboundBlob({
      dataDir: dir,
      sessionId: 's1',
      bytes: png,
      declaredMime: undefined,
      declaredName: 'shot.png',
    });
    expect(ref.mime).toBe('image/png');
    expect(ref.kind).toBe('image');
    expect(ref.name).toBe('shot.png');
    expect(ref.size).toBe(png.length);
    expect(ref.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ref.path.startsWith(mediaDirFor(dir, 's1'))).toBe(true);
    expect(ref.path.endsWith('.png')).toBe(true);
    expect(readFileSync(ref.path).equals(png)).toBe(true);
    expect(statSync(ref.path).mode & 0o777).toBe(0o600);
  });

  it('reuses existing blob on identical content (dedupe by sha256)', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x9, 0x8, 0x7]);
    const a = await cacheInboundBlob({
      dataDir: dir,
      sessionId: 's1',
      bytes: png,
      declaredMime: undefined,
      declaredName: 'a.png',
    });
    const b = await cacheInboundBlob({
      dataDir: dir,
      sessionId: 's1',
      bytes: png,
      declaredMime: undefined,
      declaredName: 'b.png',
    });
    expect(a.path).toBe(b.path);
    expect(a.sha256).toBe(b.sha256);
  });

  it('rejects oversized blobs', async () => {
    const big = Buffer.alloc(PER_FILE_MAX_BYTES + 1, 0x90);
    await expect(
      cacheInboundBlob({
        dataDir: dir,
        sessionId: 's1',
        bytes: big,
        declaredMime: 'application/pdf',
        declaredName: 'huge.pdf',
      }),
    ).rejects.toMatchObject({ code: 'too_large' });
  });

  it('rejects unrecognized binary content', async () => {
    const junk = Buffer.from([0x00, 0xff, 0xab, 0x00, 0x01]);
    await expect(
      cacheInboundBlob({
        dataDir: dir,
        sessionId: 's1',
        bytes: junk,
        declaredMime: 'application/octet-stream',
        declaredName: 'mystery.bin',
      }),
    ).rejects.toMatchObject({ code: 'mime_unrecognized' });
  });

  it('falls back to <sha256>.<ext> when name is missing', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%hello\n');
    const ref = await cacheInboundBlob({
      dataDir: dir,
      sessionId: 's1',
      bytes: pdf,
      declaredMime: undefined,
      declaredName: undefined,
    });
    expect(ref.name).toBe(`${ref.sha256}.pdf`);
  });

  it('isolates sessions in their own subdirs', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const a = await cacheInboundBlob({
      dataDir: dir,
      sessionId: 's1',
      bytes: png,
      declaredMime: undefined,
      declaredName: 'p.png',
    });
    const b = await cacheInboundBlob({
      dataDir: dir,
      sessionId: 's2',
      bytes: png,
      declaredMime: undefined,
      declaredName: 'p.png',
    });
    expect(a.path).not.toBe(b.path);
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);
  });
});

describe('stageOutboundFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reder-stage-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('copies a foreign path into the session media dir', async () => {
    const src = join(dir, 'tmp.png');
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]));
    const ref = await stageOutboundFile({
      dataDir: dir,
      sessionId: 's1',
      sourcePath: src,
    });
    expect(ref.path.startsWith(mediaDirFor(dir, 's1'))).toBe(true);
    expect(existsSync(ref.path)).toBe(true);
    expect(ref.mime).toBe('image/png');
    expect(ref.name).toBe('tmp.png');
  });

  it('is idempotent when the source is already in the session cache', async () => {
    const src = join(dir, 'tmp.pdf');
    writeFileSync(src, Buffer.from('%PDF-1.4\n%X\n'));
    const a = await stageOutboundFile({ dataDir: dir, sessionId: 's1', sourcePath: src });
    const b = await stageOutboundFile({
      dataDir: dir,
      sessionId: 's1',
      sourcePath: a.path,
    });
    expect(a.path).toBe(b.path);
    expect(a.sha256).toBe(b.sha256);
  });

  it('rejects a missing source path', async () => {
    await expect(
      stageOutboundFile({ dataDir: dir, sessionId: 's1', sourcePath: '/nope/missing.png' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects oversized files without copying', async () => {
    const src = join(dir, 'huge.pdf');
    writeFileSync(src, Buffer.alloc(PER_FILE_MAX_BYTES + 1, 0x90));
    await expect(
      stageOutboundFile({ dataDir: dir, sessionId: 's1', sourcePath: src }),
    ).rejects.toMatchObject({ code: 'too_large' });
  });
});

describe('wipeMediaForSession', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reder-media-wipe-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when the session has no media directory', () => {
    expect(wipeMediaForSession(dir, 'never-existed')).toBe(false);
  });

  it('removes the per-session directory and leaves siblings alone', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xab, 0xcd, 0xef]);
    const refA = await cacheInboundBlob({
      dataDir: dir,
      sessionId: 's-a',
      bytes: png,
      declaredMime: undefined,
      declaredName: 'a.png',
    });
    const refB = await cacheInboundBlob({
      dataDir: dir,
      sessionId: 's-b',
      bytes: png,
      declaredMime: undefined,
      declaredName: 'b.png',
    });
    expect(existsSync(refA.path)).toBe(true);
    expect(existsSync(refB.path)).toBe(true);

    expect(wipeMediaForSession(dir, 's-a')).toBe(true);

    expect(existsSync(mediaDirFor(dir, 's-a'))).toBe(false);
    expect(existsSync(refA.path)).toBe(false);
    expect(existsSync(refB.path)).toBe(true);
  });
});
