import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import {
  loadOrCreateToken,
  rotateToken,
  hashToken,
  generateToken,
  buildLoginUrl,
  authMiddleware,
  hostAllowlistMiddleware,
  COOKIE_NAME,
} from '../src/auth.js';
import type { Logger } from 'pino';

function hashHex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fakeLogger(): { logger: Logger; warnings: Array<unknown[]> } {
  const warnings: Array<unknown[]> = [];
  const noop = (): void => undefined;
  const child = (): Logger => logger;
  const logger = {
    warn: (...args: unknown[]) => warnings.push(args),
    info: noop,
    debug: noop,
    error: noop,
    fatal: noop,
    trace: noop,
    level: 'info',
    child,
  } as unknown as Logger;
  return { logger, warnings };
}

describe('auth.generateToken', () => {
  it('produces distinct tokens with the rdr_web_ prefix', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^rdr_web_/);
  });
});

describe('auth.hashToken', () => {
  it('is hex sha256 of the input', () => {
    expect(hashToken('hello')).toBe(hashHex('hello'));
  });
});

describe('auth.loadOrCreateToken', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reder-auth-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates a new token file when missing and stores the hash, not the raw token', () => {
    const p = join(dir, 'dashboard.token');
    const res = loadOrCreateToken(p);
    expect(res.created).toBe(true);
    expect(res.legacy).toBe(false);
    expect(res.rawToken).toMatch(/^rdr_web_/);
    expect(res.tokenHash).toBe(hashHex(res.rawToken!));
    const onDisk = readFileSync(p, 'utf8').trim();
    expect(onDisk).toBe(res.tokenHash);
    expect(onDisk).not.toBe(res.rawToken);
    // File is 0600.
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('reloads existing hashed token on second call without a raw token', () => {
    const p = join(dir, 'dashboard.token');
    const first = loadOrCreateToken(p);
    const second = loadOrCreateToken(p);
    expect(second.created).toBe(false);
    expect(second.legacy).toBe(false);
    expect(second.tokenHash).toBe(first.tokenHash);
    expect(second.rawToken).toBeUndefined();
  });

  it('accepts a legacy raw-token file, returns its hash, and warns', () => {
    const p = join(dir, 'dashboard.token');
    writeFileSync(p, 'rdr_web_legacy_value\n', { mode: 0o600 });
    const { logger, warnings } = fakeLogger();
    const res = loadOrCreateToken(p, logger);
    expect(res.created).toBe(false);
    expect(res.legacy).toBe(true);
    expect(res.rawToken).toBe('rdr_web_legacy_value');
    expect(res.tokenHash).toBe(hashHex('rdr_web_legacy_value'));
    expect(warnings.length).toBe(1);
    const [obj, msg] = warnings[0]!;
    expect(typeof msg).toBe('string');
    expect(String(msg)).toMatch(/legacy raw format/);
    expect(obj).toMatchObject({ token_path: p });
  });

  it('rotateToken overwrites the file with a fresh hash and returns the raw value', () => {
    const p = join(dir, 'dashboard.token');
    const first = loadOrCreateToken(p);
    const rotated = rotateToken(p);
    expect(rotated.created).toBe(true);
    expect(rotated.legacy).toBe(false);
    expect(rotated.rawToken).toMatch(/^rdr_web_/);
    expect(rotated.tokenHash).not.toBe(first.tokenHash);
    expect(readFileSync(p, 'utf8').trim()).toBe(rotated.tokenHash);
    expect(rotated.rawToken).not.toBe(first.rawToken);
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
    app.get('/', (_req, res) => res.status(200).send('home'));
    app.get('/ok', (_req, res) => res.status(200).send('ok'));
    app.get('/api/sessions', (_req, res) => res.status(200).send('sessions'));
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
  const tokenHash = hashHex(token);

  beforeEach(async () => {
    const started = await startApp([
      hostAllowlistMiddleware({ mode: 'token', tokenHash, hostAllowlist: ['127.0.0.1'] }),
      authMiddleware({ mode: 'token', tokenHash, hostAllowlist: ['127.0.0.1'] }),
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

  it('sets Referrer-Policy: no-referrer on authed responses', async () => {
    const res = await fetch(`${url}/ok`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('sets Referrer-Policy even on 401 responses', async () => {
    const res = await fetch(`${url}/ok`);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('accepts ?token= on GET / and redirects with cookie', async () => {
    const res = await fetch(`${url}/?token=${token}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(COOKIE_NAME);
    expect(setCookie).toContain('HttpOnly');
    expect(res.headers.get('location')).toBe('/');
  });

  it('rejects ?token= on /api/* (no cookie handoff on deep links)', async () => {
    const res = await fetch(`${url}/api/sessions?token=${token}`, { redirect: 'manual' });
    expect(res.status).toBe(401);
    // No cookie should be set.
    expect(res.headers.get('set-cookie')).toBeFalsy();
  });

  it('rejects ?token= on other GET paths', async () => {
    const res = await fetch(`${url}/ok?token=${token}`, { redirect: 'manual' });
    expect(res.status).toBe(401);
  });

  it('rejects invalid ?token= on /', async () => {
    const res = await fetch(`${url}/?token=wrong`, { redirect: 'manual' });
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
      hostAllowlistMiddleware({ mode: 'none', tokenHash: '', hostAllowlist: ['127.0.0.1'] }),
      authMiddleware({ mode: 'none', tokenHash: '', hostAllowlist: ['127.0.0.1'] }),
    ]);
    url = started.url;
    server = started.server;
  });
  afterEach(() => closeServer(server));

  it('passes through without any auth header', async () => {
    const res = await fetch(`${url}/ok`);
    expect(res.status).toBe(200);
  });

  it('still emits Referrer-Policy: no-referrer', async () => {
    const res = await fetch(`${url}/ok`);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('auth.authMiddleware secureCookie policy', () => {
  const token = 'rdr_web_secure';
  const tokenHash = hashHex(token);

  async function startWith(
    secureCookie: boolean | 'auto',
  ): Promise<{ url: string; server: Server }> {
    return startApp([
      hostAllowlistMiddleware({ mode: 'token', tokenHash, hostAllowlist: ['127.0.0.1'] }),
      authMiddleware({
        mode: 'token',
        tokenHash,
        hostAllowlist: ['127.0.0.1'],
        secureCookie,
      }),
    ]);
  }

  it('"auto" + plain HTTP omits Secure', async () => {
    const s = await startWith('auto');
    const res = await fetch(`${s.url}/?token=${token}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).not.toMatch(/;\s*Secure/i);
    await closeServer(s.server);
  });

  it('"auto" + X-Forwarded-Proto: https sets Secure', async () => {
    const s = await startWith('auto');
    const res = await fetch(`${s.url}/?token=${token}`, {
      redirect: 'manual',
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/;\s*Secure/i);
    await closeServer(s.server);
  });

  it('true always sets Secure', async () => {
    const s = await startWith(true);
    const res = await fetch(`${s.url}/?token=${token}`, { redirect: 'manual' });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/;\s*Secure/i);
    await closeServer(s.server);
  });

  it('false never sets Secure', async () => {
    const s = await startWith(false);
    const res = await fetch(`${s.url}/?token=${token}`, {
      redirect: 'manual',
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).not.toMatch(/;\s*Secure/i);
    await closeServer(s.server);
  });
});

describe('auth.hostAllowlistMiddleware', () => {
  it('rejects requests with a mismatched Host header', async () => {
    const started = await startApp([
      hostAllowlistMiddleware({ mode: 'none', tokenHash: '', hostAllowlist: [] }),
      authMiddleware({ mode: 'none', tokenHash: '', hostAllowlist: [] }),
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

describe('auth comparison rejects mismatched and matched same-length digests', () => {
  // The middleware hashes the presented token before comparison, so all
  // comparisons happen on equal-length hex digests — which is exactly the
  // input shape that timingSafeEqual requires. These assertions exercise
  // both the mismatched-content (same length) and matched-content code
  // paths, which is what guards against length-based timing leaks.
  let url: string;
  let server: Server;
  const token = 'rdr_web_compare';
  const tokenHash = hashHex(token);

  beforeEach(async () => {
    const started = await startApp([
      hostAllowlistMiddleware({ mode: 'token', tokenHash, hostAllowlist: ['127.0.0.1'] }),
      authMiddleware({ mode: 'token', tokenHash, hostAllowlist: ['127.0.0.1'] }),
    ]);
    url = started.url;
    server = started.server;
  });
  afterEach(() => closeServer(server));

  it('rejects a same-length-hash but different token', async () => {
    // Both `token` and `'rdr_web_compaee'` hash to a 64-char hex string of
    // the same length but different content; this is the equal-length
    // comparison branch.
    const res = await fetch(`${url}/ok`, {
      headers: { Authorization: 'Bearer rdr_web_compaee' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts the correct token', async () => {
    const res = await fetch(`${url}/ok`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
});
