import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { TelegramTransport } from './transport.js';

export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface DownloadAndCacheParams {
  transport: TelegramTransport;
  fileId: string;
  cacheDir: string;
  maxBytes?: number;
  defaultExtension?: string;
}

export interface CachedFile {
  path: string;
  size: number;
  sha256: string;
}

export class FileTooLargeError extends Error {
  override readonly name = 'FileTooLargeError';
  constructor(public readonly size: number, public readonly limit: number) {
    super(`file size ${size} bytes exceeds limit ${limit}`);
  }
}

/**
 * Download a Telegram file via the transport, cache under cacheDir/<sha256>.<ext>,
 * return the absolute path. Safe to call repeatedly — if the same content is
 * already cached, reuses it.
 */
export async function downloadAndCache(params: DownloadAndCacheParams): Promise<CachedFile> {
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  const meta = await params.transport.getFile(params.fileId);
  const data = await params.transport.downloadFile(meta.file_path);
  if (data.length > maxBytes) throw new FileTooLargeError(data.length, maxBytes);

  const sha256 = createHash('sha256').update(data).digest('hex');
  const ext = extname(meta.file_path) || params.defaultExtension || '';
  mkdirSync(params.cacheDir, { recursive: true, mode: 0o700 });
  chmodSync(params.cacheDir, 0o700);
  const path = join(params.cacheDir, `${sha256}${ext}`);
  if (!existsSync(path)) {
    writeFileSync(path, data, { mode: 0o600 });
  }
  return { path, size: data.length, sha256 };
}
