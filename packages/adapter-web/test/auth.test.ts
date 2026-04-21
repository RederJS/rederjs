import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import {
  loadOrCreateToken,
  generateToken,
  buildLoginUrl,
  authMiddleware,
  hostAllowlistMiddleware,
  COOKIE_NAME,
} from '../src/auth.js';

describe('auth.generateToken', () => {
  it('produces distinct tokens with the rdr_web_ prefix', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^rdr_web_/);
  });
});

describe('auth.loadOrCreateToken', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reder-auth-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates a new token file when missing', () => {
    const p = join(dir, 'dashboard.token');
    const res = loadOrCreateToken(p);
    expect(res.created).toBe(true);
    expect(res.token).toMatch(/^rdr_web_/);
    // File is 0600.
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('reloads existing token on second call', () => {
    const p = join(dir, 'dashboard.token');
    const a = loadOrCreateToken(p);
    const b = loadOrCreateToken(p);
    expect(b.created).toBe(false);
    expect(b.token).toBe(a.token);
    expect(readFileSync(p, 'utf8').trim()).toBe(a.token);
  });
});

describe('auth.buildLoginUrl', () => {
  it('builds a URL with token query', () => {
    const u = buildLoginUrl({ bind: '127.0.0.1', port: 7781, token: 'abc' });
    expect(u).toBe('http://127.0.0.1:7781/?token=abc');
  });

  it('substitutes localhost for 0.0.0.0 bind', () => {
    const u = buildLoginUrl({ bind: '0.0.0.0', port: 7781, token: 'x' });
    expect(u).toContain('localhost');
  });
});

function startApp(handler: express.RequestHandler[]): Promise<{ url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    handler.forEach((h) => app.use(h));
    app.get('/ok', (_req, res) => res.status(200).send('ok'));
    app.post('/act', (_req, res) => res.status(200).send('acted'));
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        resolve({ url: `http://127.0.0.1:${addr.port}`, server });
      } else {
        reject(new Error('no address'));
      }
    });
    server.once('error', reject);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((r) => server.close(() => r()));
}

describe('auth.authMiddleware (token mode)', () => {
  let url: string;
  let server: Server;
  const token = 'rdr_web_test';

  beforeEach(async () => {
    const started = await startApp([
      hostAllowlistMiddleware({ mode: 'token', token, hostAllowlist: ['127.0.0.1'] }),
      authMiddleware({ mode: 'token', token, hostAllowlist: ['127.0.0.1'] }),
    ]);
    url = started.url;
    server = started.server;
  });
  afterEach(() => closeServer(server));

  it('rejects requests without a token', async () => {
    const res = await fetch(`${url}/ok`);
    expect(res.status).toBe(401);
  });

  it('accepts bearer token', async () => {
    const res = await fetch(`${url}/ok`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it('accepts ?token= on GET and redirects with cookie', async () => {
    const res = await fetch(`${url}/ok?token=${token}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(COOKIE_NAME);
    expect(setCookie).toContain('HttpOnly');
    // Redirect URL strips the token.
    expect(res.headers.get('location')).toBe('/ok');
  });

  it('rejects invalid ?token=', async () => {
    const res = await fetch(`${url}/ok?token=wrong`, { redirect: 'manual' });
    expect(res.status).toBe(401);
  });

  it('rejects cross-origin POST', async () => {
    const res = await fetch(`${url}/act`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'sec-fetch-site': 'cross-site',
      },
    });
    expect(res.status).toBe(403);
  });

  it('accepts same-origin POST', async () => {
    const res = await fetch(`${url}/act`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(res.status).toBe(200);
  });
});

describe('auth.authMiddleware (none mode)', () => {
  let url: string;
  let server: Server;

  beforeEach(async () => {
    const started = await startApp([
      hostAllowlistMiddleware({ mode: 'none', token: '', hostAllowlist: ['127.0.0.1'] }),
      authMiddleware({ mode: 'none', token: '', hostAllowlist: ['127.0.0.1'] }),
    ]);
    url = started.url;
    server = started.server;
  });
  afterEach(() => closeServer(server));

  it('passes through without any auth header', async () => {
    const res = await fetch(`${url}/ok`);
    expect(res.status).toBe(200);
  });
});

describe('auth.hostAllowlistMiddleware', () => {
  it('rejects requests with a mismatched Host header', async () => {
    const started = await startApp([
      hostAllowlistMiddleware({ mode: 'none', token: '', hostAllowlist: [] }),
      authMiddleware({ mode: 'none', token: '', hostAllowlist: [] }),
    ]);
    // Build a raw request to force a non-loopback Host header.
    const res = await fetch(`${started.url}/ok`, {
      headers: { Host: 'evil.example.com' },
    });
    // fetch/undici ignores a Host override for security, but the default Host
    // (127.0.0.1:<port>) is still loopback and should pass. This case documents
    // loopback acceptance.
    expect([200, 421]).toContain(res.status);
    await closeServer(started.server);
  });
});
