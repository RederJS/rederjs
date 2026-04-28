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
