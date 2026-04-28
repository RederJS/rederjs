import { existsSync, statSync, createReadStream, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import { Router as expressRouter, type Request, type Response } from 'express';
import Busboy from 'busboy';
import {
  cacheInboundBlob,
  AttachmentError,
  PER_FILE_MAX_BYTES,
  mediaDirFor,
  decodeAttachmentsMeta,
} from '@rederjs/core/media';
import type { Logger } from 'pino';

export interface MediaRouteDeps {
  dataDir: string;
  logger: Logger;
  sessions: ReadonlyArray<{ session_id: string }>;
  db: Db;
}

export function createMediaRouter(deps: MediaRouteDeps): ReturnType<typeof expressRouter> {
  const r = expressRouter();

  r.post('/sessions/:id/media', (req: Request, res: Response) => {
    const sessionId = req.params['id']!;
    if (!deps.sessions.some((s) => s.session_id === sessionId)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const ct = (req.headers['content-type'] ?? '').toLowerCase();
    if (!ct.startsWith('multipart/form-data')) {
      res.status(400).json({ error: 'expected multipart/form-data' });
      return;
    }

    const bb = Busboy({
      headers: req.headers,
      limits: { fileSize: PER_FILE_MAX_BYTES + 1, files: 1 },
    });
    let handled = false;
    let aborted = false;

    bb.on('file', (_field, stream, info) => {
      if (handled || aborted) {
        stream.resume();
        return;
      }
      handled = true;
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (c: Buffer) => {
        total += c.length;
        if (total > PER_FILE_MAX_BYTES) {
          stream.removeAllListeners('data');
          aborted = true;
          if (!res.headersSent) res.status(413).json({ error: 'file too large' });
          return;
        }
        chunks.push(c);
      });
      stream.on('limit', () => {
        aborted = true;
        if (!res.headersSent) res.status(413).json({ error: 'file too large' });
      });
      stream.on('end', () => {
        if (aborted) return;
        const bytes = Buffer.concat(chunks);
        cacheInboundBlob({
          dataDir: deps.dataDir,
          sessionId,
          bytes,
          declaredMime: info.mimeType,
          declaredName: info.filename,
        })
          .then((ref) => {
            res.status(201).json({
              sha256: ref.sha256,
              size: ref.size,
              mime: ref.mime,
              name: ref.name,
              path: ref.path,
              kind: ref.kind,
            });
          })
          .catch((err: unknown) => {
            if (err instanceof AttachmentError) {
              if (err.code === 'too_large') {
                res.status(413).json({ error: err.message });
                return;
              }
              res.status(400).json({ error: err.message });
              return;
            }
            deps.logger.error({ err }, 'media upload failed');
            res.status(500).json({ error: 'upload failed' });
          });
      });
    });

    bb.on('error', (err: Error) => {
      if (!res.headersSent) res.status(400).json({ error: err.message });
    });

    bb.on('finish', () => {
      if (!handled && !res.headersSent) res.status(400).json({ error: 'no file field' });
    });

    req.pipe(bb);
  });

  const SHA256_RE = /^[a-f0-9]{64}$/;

  r.get('/sessions/:id/media/:sha256', (req: Request, res: Response) => {
    const sessionId = req.params['id']!;
    const sha = (req.params['sha256'] ?? '').toLowerCase();
    if (!SHA256_RE.test(sha)) {
      res.status(400).json({ error: 'invalid sha256' });
      return;
    }
    if (!deps.sessions.some((s) => s.session_id === sessionId)) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const ref = lookupRefBySha(deps.db, sessionId, sha);
    if (!ref) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const dir = mediaDirFor(deps.dataDir, sessionId);
    const filename = sha + (extname(ref.path) || '');
    const path = join(dir, filename);
    if (existsSync(path) && statSync(path).isFile()) {
      streamFile(res, path, ref.mime, ref.name);
      return;
    }
    // Fallback: scan the dir for any <sha>.* file (covers paths created with a
    // different extension than the stored ref).
    let alt: string | undefined;
    try {
      alt = readdirSync(dir).find((e) => e.startsWith(sha + '.'));
    } catch {
      alt = undefined;
    }
    if (!alt) {
      res.status(404).json({ error: 'blob missing' });
      return;
    }
    streamFile(res, join(dir, alt), ref.mime, ref.name);
  });

  return r;
}

function streamFile(res: Response, path: string, mime: string, name: string): void {
  res.setHeader('content-type', mime);
  res.setHeader('content-disposition', `inline; filename="${sanitizeFilename(name)}"`);
  res.setHeader('cache-control', 'private, max-age=3600');
  createReadStream(path).pipe(res);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"]/g, '_');
}

function lookupRefBySha(
  db: Db,
  sessionId: string,
  sha256: string,
): { mime: string; name: string; path: string } | null {
  const rows = db
    .prepare(
      `SELECT meta_json FROM inbound_messages WHERE session_id = ? AND meta_json LIKE ?
       UNION ALL
       SELECT meta_json FROM outbound_messages WHERE session_id = ? AND meta_json LIKE ?`,
    )
    .all(sessionId, '%' + sha256 + '%', sessionId, '%' + sha256 + '%') as Array<{
    meta_json: string;
  }>;
  for (const row of rows) {
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(row.meta_json) as Record<string, string>;
    } catch {
      continue;
    }
    const refs = decodeAttachmentsMeta(parsed['attachments']);
    const match = refs.find((r) => r.sha256 === sha256);
    if (match) return { mime: match.mime, name: match.name, path: match.path };
  }
  return null;
}
