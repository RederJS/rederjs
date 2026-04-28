import { Router as expressRouter, type Request, type Response } from 'express';
import Busboy from 'busboy';
import { cacheInboundBlob, AttachmentError, PER_FILE_MAX_BYTES } from '@rederjs/core/media';
import type { Logger } from 'pino';

export interface MediaRouteDeps {
  dataDir: string;
  logger: Logger;
  sessions: ReadonlyArray<{ session_id: string }>;
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

  return r;
}
