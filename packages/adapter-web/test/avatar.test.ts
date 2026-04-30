import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase, type DatabaseHandle } from '../../core/src/storage/db.js';
import { createLogger } from '../../core/src/logger.js';
import { createAuditLog } from '../../core/src/audit.js';
import { createIpcServer, type IpcServer } from '../../core/src/ipc/server.js';
import { createRouter, type Router } from '../../core/src/router.js';
import { createSession } from '../../core/src/sessions.js';
import { createAdapterStorage } from '../../core/src/storage/kv.js';
import { WebAdapter } from '../src/index.js';
import type { AdapterContext } from '../../core/src/adapter.js';

let dir: string;
let db: DatabaseHandle;
let ipcServer: IpcServer;
let router: Router;
let adapter: WebAdapter;
let token: string;
let baseUrl: string;
let pngPath: string;

async function ephemeralPort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => res(port));
    });
  });
}

// 1x1 transparent PNG.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c63000100000005000148b9c4ff00000000' +
    '49454e44ae426082',
  'hex',
);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-web-avatar-'));
  db = openDatabase(join(dir, 'test.db'));
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  const audit = createAuditLog(dir);
  ipcServer = await createIpcServer({ db: db.raw, socketPath: join(dir, 'r.sock'), logger });
  router = createRouter({ db: db.raw, ipcServer, logger, audit, dataDir: dir });
  await createSession(db.raw, 'with-avatar', 'WithAvatar');
  await createSession(db.raw, 'no-avatar', 'NoAvatar');
  await createSession(db.raw, 'svg-avatar', 'SvgAvatar');

  pngPath = join(dir, 'avatar.png');
  writeFileSync(pngPath, TINY_PNG);
  const svgPath = join(dir, 'avatar.svg');
  writeFileSync(svgPath, '<svg/>');

  const port = await ephemeralPort();
  adapter = new WebAdapter({ db: db.raw });
  const ctx: AdapterContext = {
    logger: logger.child({ component: 'adapter.web' }),
    config: { bind: '127.0.0.1', port, auth: 'token', host_allowlist: [], sender_id: 'web:local' },
    storage: createAdapterStorage(db.raw, 'web'),
    router,
    dataDir: dir,
    sessions: [
      {
        session_id: 'with-avatar',
        display_name: 'WithAvatar',
        avatar_path: pngPath,
        auto_start: false,
      },
      { session_id: 'no-avatar', display_name: 'NoAvatar', auto_start: false },
      {
        session_id: 'svg-avatar',
        display_name: 'SvgAvatar',
        avatar_path: svgPath,
        auto_start: false,
      },
    ],
    db: db.raw,
  };
  await adapter.start(ctx);
  router.registerAdapter('web', { adapter });
  baseUrl = `http://127.0.0.1:${port}`;
  token = readFileSync(join(dir, 'dashboard.token'), 'utf8').trim();
});

afterEach(async () => {
  await adapter?.stop();
  await router?.stop();
  await ipcServer?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/sessions/:id/avatar', () => {
  it('returns 200 with the configured PNG and image/png mime', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/with-avatar/avatar`, {
      headers: { Authorization: `Bearer ${token}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(TINY_PNG)).toBe(true);
  });

  it('returns 404 when the session has no avatar configured', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/no-avatar/avatar`, {
      headers: { Authorization: `Bearer ${token}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown session id', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/does-not-exist/avatar`, {
      headers: { Authorization: `Bearer ${token}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(404);
  });

  it('returns 415 when the configured file extension is unsupported', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/svg-avatar/avatar`, {
      headers: { Authorization: `Bearer ${token}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(415);
  });

  it('returns 404 when the configured file is missing on disk', async () => {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(pngPath);
    const res = await fetch(`${baseUrl}/api/sessions/with-avatar/avatar`, {
      headers: { Authorization: `Bearer ${token}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(404);
  });

  it('honors If-None-Match by returning 304', async () => {
    const first = await fetch(`${baseUrl}/api/sessions/with-avatar/avatar`, {
      headers: { Authorization: `Bearer ${token}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).not.toBeNull();
    const second = await fetch(`${baseUrl}/api/sessions/with-avatar/avatar`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'sec-fetch-site': 'same-origin',
        'if-none-match': etag!,
      },
    });
    expect(second.status).toBe(304);
  });
});

describe('GET /api/sessions includes avatar_url', () => {
  it('returns avatar_url for sessions with an avatar', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${token}`, 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ session_id: string; avatar_url: string | null }>;
    };
    const withAv = body.sessions.find((s) => s.session_id === 'with-avatar');
    expect(withAv?.avatar_url).toMatch(/^\/api\/sessions\/with-avatar\/avatar\?v=\d+$/);
    const noAv = body.sessions.find((s) => s.session_id === 'no-avatar');
    expect(noAv?.avatar_url).toBeNull();
  });
});
