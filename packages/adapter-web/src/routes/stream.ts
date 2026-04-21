import { Router as expressRouter, type Request, type Response } from 'express';
import type { SseRegistry } from '../sse.js';

export interface StreamRouteDeps {
  sse: SseRegistry;
  sessions: readonly { session_id: string }[];
}

export function createStreamRouter(deps: StreamRouteDeps): ReturnType<typeof expressRouter> {
  const r = expressRouter();

  r.get('/stream', (_req: Request, res: Response) => {
    deps.sse.subscribe(res, null);
  });

  r.get('/sessions/:id/stream', (req: Request, res: Response) => {
    const sessionId = req.params['id']!;
    if (!deps.sessions.some((s) => s.session_id === sessionId)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    deps.sse.subscribe(res, sessionId);
  });

  return r;
}
