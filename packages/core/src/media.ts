import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, join, resolve as resolvePath } from 'node:path';

export type AttachmentKind = 'image' | 'document';

export interface AttachmentRef {
  readonly path: string;
  readonly mime: string;
  readonly name: string;
  readonly kind: AttachmentKind;
  readonly size: number;
  readonly sha256: string;
}

export const PER_FILE_MAX_BYTES = 20 * 1024 * 1024;

export const PER_MESSAGE_MAX_ATTACHMENTS = {
  web: 5,
  telegram: 1,
} as const;

/** Canonical MIME → kind map. Anything not here is rejected. */
export const ALLOWED_MIMES: Record<string, AttachmentKind> = Object.freeze({
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'application/pdf': 'document',
  'text/markdown': 'document',
  'text/plain': 'document',
});

const EXT_BY_MIME: Record<string, string> = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/markdown': '.md',
  'text/plain': '.txt',
});

const MIME_BY_EXT: Record<string, string> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
});

export class AttachmentError extends Error {
  override readonly name = 'AttachmentError';
  constructor(
    public readonly code:
      | 'too_large'
      | 'mime_not_allowed'
      | 'mime_unrecognized'
      | 'not_found'
      | 'read_failed',
    message: string,
  ) {
    super(message);
  }
}

export function mediaDirFor(dataDir: string, sessionId: string): string {
  return join(dataDir, 'media', 'sessions', sessionId);
}

/**
 * Produce the on-disk filename for a blob: `<sha256><ext>`. Prefers the ext
 * implied by `mime`; falls back to lowercased `nameExt` if no MIME match.
 */
export function blobFilename(sha256: string, mime: string, nameExt?: string): string {
  const fromMime = EXT_BY_MIME[mime];
  if (fromMime) return `${sha256}${fromMime}`;
  const ne = (nameExt ?? '').toLowerCase();
  return `${sha256}${ne}`;
}

export function extensionFor(mime: string): string | undefined {
  return EXT_BY_MIME[mime];
}

export function mimeForExtension(ext: string): string | undefined {
  return MIME_BY_EXT[ext.toLowerCase()];
}

export function isAllowedMime(mime: string): boolean {
  return mime in ALLOWED_MIMES;
}

export function kindForMime(mime: string): AttachmentKind | undefined {
  return ALLOWED_MIMES[mime];
}

/**
 * Sniff the MIME type of a buffer. Returns one of the seven allowlisted MIMEs
 * or `undefined` if the bytes are unrecognized. The declared MIME and source
 * filename are *hints only* — magic-byte detection wins.
 *
 * For text/markdown vs text/plain, we sniff "is it utf-8 text?" then choose
 * by the filename extension (`.md` → markdown, anything else → plain).
 */
export function sniffMime(
  buf: Buffer,
  _declaredMime: string | undefined,
  name: string | undefined,
): string | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf.slice(0, 4).toString('ascii') === 'RIFF' &&
    buf.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buf.length >= 5 && buf.slice(0, 5).toString('ascii') === '%PDF-') {
    return 'application/pdf';
  }
  if (looksLikeText(buf)) {
    const ext = (name ? extname(name) : '').toLowerCase();
    if (ext === '.md') return 'text/markdown';
    return 'text/plain';
  }
  return undefined;
}

function looksLikeText(buf: Buffer): boolean {
  const sample = buf.slice(0, Math.min(buf.length, 1024));
  if (sample.length === 0) return false;
  for (const b of sample) {
    if (b === 0) return false;
  }
  try {
    const str = sample.toString('utf8');
    let printable = 0;
    for (const ch of str) {
      const code = ch.codePointAt(0)!;
      if (code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20) printable++;
    }
    return printable / str.length >= 0.95;
  } catch {
    return false;
  }
}

export function encodeAttachmentsMeta(refs: readonly AttachmentRef[]): string {
  if (refs.length === 0) return '';
  return JSON.stringify(refs);
}

export function decodeAttachmentsMeta(raw: string | undefined): AttachmentRef[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: AttachmentRef[] = [];
  for (const item of parsed) {
    if (!isAttachmentRef(item)) continue;
    out.push(item);
  }
  return out;
}

function isAttachmentRef(v: unknown): v is AttachmentRef {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['path'] === 'string' &&
    typeof r['mime'] === 'string' &&
    typeof r['name'] === 'string' &&
    (r['kind'] === 'image' || r['kind'] === 'document') &&
    typeof r['size'] === 'number' &&
    typeof r['sha256'] === 'string' &&
    /^[a-f0-9]{64}$/.test(r['sha256'] as string)
  );
}

export interface CacheInboundBlobInput {
  readonly dataDir: string;
  readonly sessionId: string;
  readonly bytes: Buffer;
  readonly declaredMime: string | undefined;
  readonly declaredName: string | undefined;
}

export async function cacheInboundBlob(input: CacheInboundBlobInput): Promise<AttachmentRef> {
  if (input.bytes.length > PER_FILE_MAX_BYTES) {
    throw new AttachmentError(
      'too_large',
      `attachment is ${input.bytes.length} bytes (max ${PER_FILE_MAX_BYTES})`,
    );
  }
  const mime = sniffMime(input.bytes, input.declaredMime, input.declaredName);
  if (!mime) {
    throw new AttachmentError(
      'mime_unrecognized',
      'could not identify file type from content',
    );
  }
  if (!isAllowedMime(mime)) {
    throw new AttachmentError('mime_not_allowed', `mime ${mime} is not allowed`);
  }

  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const dir = mediaDirFor(input.dataDir, input.sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const filename = blobFilename(sha256, mime);
  const path = join(dir, filename);
  if (!existsSync(path)) {
    writeFileSync(path, input.bytes, { mode: 0o600 });
  } else {
    chmodSync(path, 0o600);
  }

  const kind = kindForMime(mime);
  if (!kind) {
    throw new AttachmentError('mime_not_allowed', `internal: no kind for mime ${mime}`);
  }
  const fallbackName =
    input.declaredName && input.declaredName.length > 0
      ? input.declaredName
      : `${sha256}${extensionFor(mime) ?? ''}`;

  return {
    path,
    mime,
    name: fallbackName,
    kind,
    size: input.bytes.length,
    sha256,
  };
}
