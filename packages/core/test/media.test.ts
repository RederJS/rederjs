import { describe, it, expect } from 'vitest';
import { sniffMime } from '../src/media.js';

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
    expect(sniffMime(Buffer.from('%PDF-1.7\n'), undefined, undefined)).toBe(
      'application/pdf',
    );
  });

  it('returns text/markdown for utf-8 text when name has .md', () => {
    expect(sniffMime(Buffer.from('# hello\n'), undefined, 'README.md')).toBe(
      'text/markdown',
    );
  });

  it('returns text/plain for utf-8 text without a recognized extension', () => {
    expect(sniffMime(Buffer.from('plain text body\n'), undefined, 'notes')).toBe(
      'text/plain',
    );
  });

  it('returns text/plain when name ends in .txt', () => {
    expect(sniffMime(Buffer.from('plain text\n'), undefined, 'log.txt')).toBe(
      'text/plain',
    );
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
