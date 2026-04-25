import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
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
let innerServer: Server;

async function ephemeralPort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-web-int-'));
  db = openDatabase(join(dir, 'test.db'));
  const socketPath = join(dir, 'reder.sock');
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  const audit = createAuditLog(dir);
  ipcServer = await createIpcServer({ db: db.raw, socketPath, logger });
  router = createRouter({ db: db.raw, ipcServer, logger, audit, outboundInitialBackoffMs: 1 });
  await createSession(db.raw, 'demo', 'Demo');
  token = ''; // set after adapter starts

  const port = await ephemeralPort();
  adapter = new WebAdapter({ db: db.raw });

  const ctx: AdapterContext = {
    logger: logger.child({ component: 'adapter.web' }),
    config: {
      bind: '127.0.0.1',
      port,
      auth: 'token',
      host_allowlist: [],
      sender_id: 'web:local',
    },
    storage: createAdapterStorage(db.raw, 'web'),
    router,
    dataDir: dir,
    sessions: [
      {
        session_id: 'demo',
        display_name: 'Demo',
        workspace_dir: join(dir, 'nonexistent-ws'),
        auto_start: false,
      },
    ],
    db: db.raw,
  };
  await adapter.start(ctx);
  router.registerAdapter('web', { adapter });
  baseUrl = `http://127.0.0.1:${port}`;
  // Token is persisted; read it via the adapter.
  const tokPath = join(dir, 'dashboard.token');
  const { readFileSync } = await import('node:fs');
  token = readFileSync(tokPath, 'utf8').trim();

  // Hold a ref to the http server so we can ensure cleanup (defensive).
  innerServer = (adapter as unknown as { server: Server }).server;
});

afterEach(async () => {
  await adapter?.stop();
  await router?.stop();
  await ipcServer?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
  void innerServer;
});

describe('adapter-web http surface', () => {
  it('GET /health is unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeTruthy();
  });

  it('GET /api/sessions requires auth', async () => {
    const unauth = await fetch(`${baseUrl}/api/sessions`);
    expect(unauth.status).toBe(401);
    const res = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ session_id: string }> };
    expect(body.sessions.map((s) => s.session_id)).toEqual(['demo']);
  });

  it('POST /api/sessions/:id/messages ingests via router', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/demo/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ content: 'hello from web' }),
    });
    expect(res.status).toBe(202);
    const rowCount = db.raw
      .prepare(
        `SELECT COUNT(*) as c FROM inbound_messages WHERE session_id = 'demo' AND adapter = 'web'`,
      )
      .get() as { c: number };
    expect(rowCount.c).toBe(1);
  });

  it('cross-origin POST is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/demo/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('GET /api/sessions/:id/messages returns transcript, clears unread', async () => {
    await router.ingestInbound({
      adapter: 'telegram',
      sessionId: 'demo',
      senderId: '42',
      content: 'from tg',
      meta: {},
      files: [],
      receivedAt: new Date(),
    });
    // Give the event listener a tick to bump unread.
    await new Promise((r) => setTimeout(r, 20));
    const before = await fetch(`${baseUrl}/api/sessions/demo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const beforeBody = (await before.json()) as { unread: number };
    expect(beforeBody.unread).toBe(1);

    const msgs = await fetch(`${baseUrl}/api/sessions/demo/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const msgsBody = (await msgs.json()) as {
      messages: Array<{ direction: string; content: string }>;
    };
    expect(msgsBody.messages).toHaveLength(1);
    expect(msgsBody.messages[0]).toMatchObject({ direction: 'inbound', content: 'from tg' });

    const after = await fetch(`${baseUrl}/api/sessions/demo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const afterBody = (await after.json()) as { unread: number };
    expect(afterBody.unread).toBe(0);
  });

  it('includes activity_state in /api/sessions', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as {
      sessions: Array<{ session_id: string; activity_state: string }>;
    };
    expect(res.status).toBe(200);
    // Fixture has no tmux and no shim connection, so every session is offline.
    const demo = body.sessions.find((s) => s.session_id === 'demo');
    expect(demo).toBeDefined();
    expect(demo!.activity_state).toBe('offline');
  });

  it('POST /api/sessions/:id/start errors when workspace_dir is missing on disk', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/demo/start`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'sec-fetch-site': 'same-origin',
      },
    });
    // May be 200 (not started, reason) or 201. We asserted `started: false` with
    // reason 'missing_dir' or 'tmux_error' depending on whether tmux is installed.
    const body = (await res.json()) as { started: boolean; reason?: string };
    expect(body.started).toBe(false);
    expect(['missing_dir', 'tmux_error', 'already_running']).toContain(body.reason);
  });

  it('POST /api/sessions/:id/repair returns 501 when no callback is wired', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/demo/repair`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    // Test fixture doesn't inject a repairSession, so expect 501.
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('repair not available');
  });

  it('POST /api/sessions/:id/repair returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nope/repair`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/system/stats returns system-wide cpu and memory metrics', async () => {
    const unauth = await fetch(`${baseUrl}/api/system/stats`);
    expect(unauth.status).toBe(401);
    const res = await fetch(`${baseUrl}/api/system/stats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as {
      cpu_percent: number;
      cpu_per_core: number[];
      mem_used_bytes: number;
      mem_total_bytes: number;
      mem_percent: number;
      uptime_seconds: number;
    };
    expect(typeof body.cpu_percent).toBe('number');
    expect(body.cpu_percent).toBeGreaterThanOrEqual(0);
    expect(body.cpu_percent).toBeLessThanOrEqual(100);
    expect(Array.isArray(body.cpu_per_core)).toBe(true);
    expect(body.cpu_per_core.length).toBeGreaterThan(0);
    for (const v of body.cpu_per_core) {
      expect(typeof v).toBe('number');
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(typeof body.mem_total_bytes).toBe('number');
    expect(body.mem_total_bytes).toBeGreaterThan(0);
    expect(body.mem_used_bytes).toBeGreaterThanOrEqual(0);
    expect(body.mem_used_bytes).toBeLessThanOrEqual(body.mem_total_bytes);
    expect(body.mem_percent).toBeGreaterThanOrEqual(0);
    expect(body.mem_percent).toBeLessThanOrEqual(100);
    expect(typeof body.uptime_seconds).toBe('number');
    expect(body.uptime_seconds).toBeGreaterThan(0);
  });
});
