import { createReadStream, statSync } from 'node:fs';
import { extname } from 'node:path';
import { Router as expressRouter, type Request, type Response } from 'express';

export interface AvatarRouteSession {
  session_id: string;
  avatar_path?: string;
}

export interface AvatarRouteDeps {
  sessions: readonly AvatarRouteSession[];
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function createAvatarRouter(deps: AvatarRouteDeps): ReturnType<typeof expressRouter> {
  const r = expressRouter();
  r.get('/sessions/:id/avatar', (req: Request, res: Response) => {
    const sessionId = req.params['id']!;
    const cfg = deps.sessions.find((s) => s.session_id === sessionId);
    if (!cfg) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const path = cfg.avatar_path;
    if (!path) {
      res.status(404).json({ error: 'no avatar configured' });
      return;
    }
    const ext = extname(path).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      res.status(415).json({ error: `unsupported avatar type: ${ext}` });
      return;
    }
    let stat;
    try {
      stat = statSync(path);
    } catch {
      res.status(404).json({ error: 'avatar file missing' });
      return;
    }
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('content-type', mime);
    res.setHeader('cache-control', 'private, max-age=60');
    res.setHeader('etag', etag);
    createReadStream(path).pipe(res);
  });
  return r;
}
