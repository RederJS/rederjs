import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import express, { type Express } from 'express';
import type { Database as Db } from 'better-sqlite3';
import type { Logger } from 'pino';
import type { AdapterStorage, RouterHandle } from '@rederjs/core/adapter';
import { authMiddleware, hostAllowlistMiddleware, type AuthOptions } from './auth.js';
import { createAvatarRouter } from './routes/avatar.js';
import { createSessionsRouter, type SessionConfigEntry } from './routes/sessions.js';
import { createPermissionsRouter } from './routes/permissions.js';
import { createStreamRouter } from './routes/stream.js';
import { createSystemRouter } from './routes/system.js';
import { createMediaRouter } from './routes/media.js';
import type { SseRegistry } from './sse.js';

export interface BuildAppOptions {
  auth: AuthOptions;
  db: Db;
  router: RouterHandle;
  storage: AdapterStorage;
  logger: Logger;
  sessions: readonly SessionConfigEntry[];
  sse: SseRegistry;
  adapterName: string;
  senderId: string;
  healthSnapshot: () => Promise<unknown>;
  /** Directory containing the built SPA (index.html + assets/). */
  staticDir?: string;
  exposeHealth: boolean;
  dataDir: string;
}

export function buildApp(opts: BuildAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use(hostAllowlistMiddleware(opts.auth));

  // Unauthenticated health endpoints — external monitors + `reder status`.
  if (opts.exposeHealth) {
    const handler = async (_req: express.Request, res: express.Response): Promise<void> => {
      try {
        const snap = await opts.healthSnapshot();
        res.setHeader('content-type', 'application/json');
        res.status(200).send(JSON.stringify(snap));
      } catch (err) {
        opts.logger.error({ err }, 'health snapshot failed');
        res.status(500).type('text/plain').send('snapshot failed');
      }
    };
    app.get('/health', handler);
    app.get('/healthz', handler);
  }

  // Token/login bootstrap — serving `/` also accepts ?token= for cookie handoff,
  // handled inside authMiddleware.
  app.use(authMiddleware(opts.auth));

  const api = express.Router();
  api.use(
    createSessionsRouter({
      db: opts.db,
      router: opts.router,
      logger: opts.logger,
      sessions: opts.sessions,
      storage: opts.storage,
      sse: opts.sse,
      adapterName: opts.adapterName,
      senderId: opts.senderId,
      isSessionConnected: (sid) => opts.router.isSessionConnected(sid),
    }),
  );
  api.use(
    createPermissionsRouter({
      router: opts.router,
      respondent: `${opts.adapterName}:${opts.senderId}`,
    }),
  );
  api.use(createStreamRouter({ sse: opts.sse, sessions: opts.sessions }));
  api.use(createSystemRouter());
  api.use(
    createMediaRouter({
      dataDir: opts.dataDir,
      logger: opts.logger,
      sessions: opts.sessions,
      db: opts.db,
    }),
  );
  api.use(createAvatarRouter({ sessions: opts.sessions }));

  app.use('/api', api);

  // Static SPA. Index served for any non-API path.
  if (opts.staticDir && existsSync(opts.staticDir)) {
    const dir = resolve(opts.staticDir);
    app.use(express.static(dir, { index: false, maxAge: '1h' }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      const idx = join(dir, 'index.html');
      if (!existsSync(idx)) {
        res.status(404).type('text/plain').send('SPA not built');
        return;
      }
      res.sendFile(idx);
    });
  } else {
    app.get('/', (_req, res) => {
      res
        .status(200)
        .type('text/html')
        .send(
          '<!doctype html><meta charset="utf-8"><title>reder</title>' +
            '<body><pre>Reder dashboard\n\n' +
            'Static UI not built. Run `npm run build:web` in @rederjs/adapter-web\n' +
            'or use the JSON API directly at /api/sessions.</pre></body>',
        );
    });
  }

  return app;
}

export function listen(app: Express, bind: string, port: number): Promise<Server> {
  return new Promise((resolveP, reject) => {
    const server = app.listen(port, bind, () => resolveP(server));
    server.once('error', reject);
  });
}
