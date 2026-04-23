import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Logger } from 'pino';

export interface HealthSnapshot {
  daemon: {
    uptime_s: number;
    started_at: string;
    config_path: string;
    version: string;
  };
  adapters: AdapterHealthSnapshot[];
  outbox: {
    inbound_pending: number;
    outbound_pending: number;
  };
  sessions: Array<{
    session_id: string;
    state: 'registered' | 'connected' | 'disconnected' | 'revoked';
    last_seen_at: string | null;
  }>;
}

export interface AdapterHealthSnapshot {
  name: string;
  healthy: boolean;
  connected_since: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  details: Record<string, unknown>;
}

export interface HealthEndpointOptions {
  bind: string;
  port: number;
  snapshot: () => Promise<HealthSnapshot>;
  logger: Logger;
}

export interface HealthEndpoint {
  close(): Promise<void>;
  readonly port: number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export async function startHealthEndpoint(opts: HealthEndpointOptions): Promise<HealthEndpoint> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const remote = req.socket.remoteAddress ?? '';
    const normalized = remote.startsWith('::ffff:') ? remote.slice(7) : remote;
    if (!LOOPBACK.has(normalized) && normalized !== opts.bind) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    if (req.url === '/health' || req.url === '/' || req.url === '/healthz') {
      void opts
        .snapshot()
        .then((snap) => {
          res.setHeader('content-type', 'application/json');
          res.statusCode = 200;
          res.end(JSON.stringify(snap));
        })
        .catch((err) => {
          opts.logger.error({ err, component: 'core.health' }, 'snapshot failed');
          res.statusCode = 500;
          res.end('snapshot failed');
        });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.bind, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;

  opts.logger.info(
    { bind: opts.bind, port, component: 'core.health' },
    'health endpoint listening',
  );

  return {
    port,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
