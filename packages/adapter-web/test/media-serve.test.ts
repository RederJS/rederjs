import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
  dir = mkdtempSync(join(tmpdir(), 'reder-web-serve-'));
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
  token = readFileSync(join(dir, 'dashboard.token'), 'utf8').trim();
});

afterEach(async () => {
  await adapter?.stop();
  await router?.stop();
  await ipcServer?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function uploadAndPersist(png: Buffer): Promise<{
  sha256: string;
  path: string;
  mime: string;
  name: string;
  size: number;
}> {
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'p.png');
  const upRes = await fetch(`${baseUrl}/api/sessions/demo/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'sec-fetch-site': 'same-origin' },
    body: fd,
  });
  expect(upRes.status).toBe(201);
  const up = (await upRes.json()) as {
    sha256: string;
    path: string;
    mime: string;
    name: string;
    size: number;
  };
  // Send a message that references the file so the row exists in the DB.
  const msgRes = await fetch(`${baseUrl}/api/sessions/demo/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({
      content: '',
      files: [up.path],
      meta: {
        attachments: JSON.stringify([
          {
            path: up.path,
            mime: up.mime,
            name: up.name,
            kind: 'image',
            size: up.size,
            sha256: up.sha256,
          },
        ]),
      },
    }),
  });
  expect(msgRes.status).toBe(202);
  return up;
}

describe('GET /api/sessions/:sessionId/media/:sha256', () => {
  it('streams the file with the right Content-Type when authenticated', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    const up = await uploadAndPersist(png);
    const res = await fetch(`${baseUrl}/api/sessions/demo/media/${up.sha256}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(png)).toBe(true);
  });

  it('rejects unauthenticated', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
    const up = await uploadAndPersist(png);
    const res = await fetch(`${baseUrl}/api/sessions/demo/media/${up.sha256}`);
    expect(res.status).toBe(401);
  });

  it('400s on malformed sha256', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/demo/media/notreallyasha`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it('sanitizes the Content-Disposition filename against RFC 6266 injection', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xab, 0xcd]);
    // Upload a file (filename here doesn't matter for the served header — the
    // Content-Disposition reads from meta.attachments[0].name via lookupRefBySha).
    const fd = new FormData();
    fd.append('file', new Blob([png], { type: 'image/png' }), 'safe.png');
    const upRes = await fetch(`${baseUrl}/api/sessions/demo/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'sec-fetch-site': 'same-origin' },
      body: fd,
    });
    const up = (await upRes.json()) as {
      sha256: string;
      path: string;
      mime: string;
      size: number;
    };
    // Attach a malicious filename via meta.attachments. This is what the GET
    // serve handler reads to set Content-Disposition.
    const evilName = 'evil"; filename=pwned.exe; \\\r\nLeaked: secret';
    const msgRes = await fetch(`${baseUrl}/api/sessions/demo/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({
        content: '',
        files: [up.path],
        meta: {
          attachments: JSON.stringify([
            {
              path: up.path,
              mime: up.mime,
              name: evilName,
              kind: 'image',
              size: up.size,
              sha256: up.sha256,
            },
          ]),
        },
      }),
    });
    expect(msgRes.status).toBe(202);
    const res = await fetch(`${baseUrl}/api/sessions/demo/media/${up.sha256}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition') ?? '';
    // The filename value sits inside a quoted-string. To prevent the attacker
    // from injecting a second parameter (e.g. attachment;filename=pwned.exe),
    // the quoted value must not contain raw `"`, `;`, `\\`, CR, or LF.
    expect(cd.startsWith('inline; filename="')).toBe(true);
    expect(cd.endsWith('"')).toBe(true);
    const value = cd.slice('inline; filename="'.length, -1);
    expect(value).not.toMatch(/["\\;,\r\n]/);
  });

  it('404s on unknown sha256', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/demo/media/${'a'.repeat(64)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it('404s when sha256 belongs to a different session', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 22]);
    const up = await uploadAndPersist(png);
    const res = await fetch(`${baseUrl}/api/sessions/other/media/${up.sha256}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Session 'other' isn't in the configured sessions list -> 404 from the
    // session existence check.
    expect(res.status).toBe(404);
  });
});
