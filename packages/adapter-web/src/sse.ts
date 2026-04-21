import type { Response } from 'express';
import type { Logger } from 'pino';

const HEARTBEAT_INTERVAL_MS = 20_000;

export interface SseEvent {
  event: string;
  data: unknown;
  id?: string;
}

interface Subscriber {
  id: number;
  sessionId: string | null;
  res: Response;
  heartbeat: NodeJS.Timeout;
}

export interface SseRegistry {
  /** Attach a response and keep it open for SSE. */
  subscribe(res: Response, sessionId: string | null): () => void;
  /** Push an event to every subscriber matching the given session (or null ⇒ broadcast). */
  publish(sessionId: string | null, event: SseEvent): void;
  /** Push to ALL subscribers regardless of sessionId filter. */
  broadcast(event: SseEvent): void;
  /** Number of active connections. */
  size(): number;
  /** Close every open stream. */
  closeAll(): void;
}

export function createSseRegistry(logger?: Logger): SseRegistry {
  const subs = new Map<number, Subscriber>();
  let nextId = 1;

  function writeEvent(res: Response, event: SseEvent): boolean {
    try {
      if (event.id) res.write(`id: ${event.id}\n`);
      res.write(`event: ${event.event}\n`);
      res.write(`data: ${JSON.stringify(event.data)}\n\n`);
      return true;
    } catch (err) {
      logger?.debug({ err }, 'sse write failed');
      return false;
    }
  }

  function subscribe(res: Response, sessionId: string | null): () => void {
    const id = nextId++;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    // Initial comment to defeat proxy buffering + signal the stream is live.
    res.write(`: connected ${id}\n\n`);

    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        // if write fails, close sub.
        close();
      }
    }, HEARTBEAT_INTERVAL_MS);

    const sub: Subscriber = { id, sessionId, res, heartbeat };
    subs.set(id, sub);

    const close = (): void => {
      clearInterval(heartbeat);
      subs.delete(id);
      try {
        res.end();
      } catch {
        // ignore
      }
    };

    res.on('close', close);
    res.on('error', close);
    return close;
  }

  function publish(sessionId: string | null, event: SseEvent): void {
    for (const sub of subs.values()) {
      if (sessionId !== null && sub.sessionId !== null && sub.sessionId !== sessionId) continue;
      const ok = writeEvent(sub.res, event);
      if (!ok) {
        clearInterval(sub.heartbeat);
        subs.delete(sub.id);
      }
    }
  }

  function broadcast(event: SseEvent): void {
    publish(null, event);
  }

  function size(): number {
    return subs.size;
  }

  function closeAll(): void {
    for (const sub of Array.from(subs.values())) {
      clearInterval(sub.heartbeat);
      try {
        sub.res.end();
      } catch {
        // ignore
      }
      subs.delete(sub.id);
    }
  }

  return { subscribe, publish, broadcast, size, closeAll };
}
