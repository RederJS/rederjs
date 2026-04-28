import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-web-up-'));
  db = openDatabase(join(dir, 'test.db'));
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  const audit = createAuditLog(dir);
  ipcServer = await createIpcServer({ db: db.raw, socketPath: join(dir, 'r.sock'), logger });
  router = createRouter({ db: db.raw, ipcServer, logger, audit, dataDir: dir });
  await createSession(db.raw, 'demo', 'Demo');
  const port = await ephemeralPort();
  adapter = new WebAdapter({ db: db.raw });
  const ctx: AdapterContext = {
    logger: logger.child({ component: 'adapter.web' }),
    config: { bind: '127.0.0.1', port, auth: 'token', host_allowlist: [], sender_id: 'web:local' },
    storage: createAdapterStorage(db.raw, 'web'),
    router,
    dataDir: dir,
    sessions: [{ session_id: 'demo', display_name: 'Demo', auto_start: false }],
    db: db.raw,
  };
  await adapter.start(ctx);
  router.registerAdapter('web', { adapter });
  baseUrl = `http://127.0.0.1:${port}`;
  const { readFileSync } = await import('node:fs');
  token = readFileSync(join(dir, 'dashboard.token'), 'utf8').trim();
});

afterEach(async () => {
  await adapter?.stop();
  await router?.stop();
  await ipcServer?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function uploadPng(name: string, body: Buffer): Promise<Response> {
  const fd = new FormData();
  fd.append('file', new Blob([body], { type: 'image/png' }), name);
  return fetch(`${baseUrl}/api/sessions/demo/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'sec-fetch-site': 'same-origin' },
    body: fd,
  });
}

describe('POST /api/sessions/:id/media', () => {
  it('caches a PNG under media/sessions/<id>/', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const res = await uploadPng('shot.png', png);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      sha256: string;
      size: number;
      mime: string;
      name: string;
      path: string;
      kind: string;
    };
    expect(body.mime).toBe('image/png');
    expect(body.kind).toBe('image');
    expect(body.size).toBe(png.length);
    expect(body.name).toBe('shot.png');
    expect(body.sha256).toMatch(/^[a-f0-9]{64}$/);
    const files = readdirSync(join(dir, 'media', 'sessions', 'demo'));
    expect(files).toContain(body.sha256 + '.png');
  });

  it('rejects unauthorized', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('x')], { type: 'image/png' }), 'x.png');
    const res = await fetch(`${baseUrl}/api/sessions/demo/media`, {
      method: 'POST',
      body: fd,
    });
    expect(res.status).toBe(401);
  });

  it('rejects unknown session 404', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fd = new FormData();
    fd.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
    const res = await fetch(`${baseUrl}/api/sessions/no-such/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'sec-fetch-site': 'same-origin' },
      body: fd,
    });
    expect(res.status).toBe(404);
  });

  it('rejects 21 MB upload with 413', async () => {
    const big = Buffer.alloc(21 * 1024 * 1024);
    big[0] = 0x89;
    big[1] = 0x50;
    big[2] = 0x4e;
    big[3] = 0x47;
    big[4] = 0x0d;
    big[5] = 0x0a;
    big[6] = 0x1a;
    big[7] = 0x0a;
    const res = await uploadPng('big.png', big);
    expect(res.status).toBe(413);
  });

  it('rejects truly unrecognized binary with 400', async () => {
    const garbage = Buffer.from([0x00, 0x99, 0xab, 0x00]);
    const fd = new FormData();
    fd.append('file', new Blob([garbage], { type: 'application/octet-stream' }), 'mystery.bin');
    const res = await fetch(`${baseUrl}/api/sessions/demo/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'sec-fetch-site': 'same-origin' },
      body: fd,
    });
    expect(res.status).toBe(400);
  });

  it('accepts a markdown text upload', async () => {
    const md = Buffer.from('# title\n\ncontent\n');
    const fd = new FormData();
    fd.append('file', new Blob([md], { type: 'text/markdown' }), 'README.md');
    const res = await fetch(`${baseUrl}/api/sessions/demo/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'sec-fetch-site': 'same-origin' },
      body: fd,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { mime: string; kind: string };
    expect(body.mime).toBe('text/markdown');
    expect(body.kind).toBe('document');
  });
});
