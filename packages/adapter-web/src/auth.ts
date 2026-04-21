import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

export const COOKIE_NAME = 'reder_token';
const TOKEN_BYTES = 32;
const TOKEN_PREFIX = 'rdr_web_';

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
}

export interface TokenFile {
  token: string;
  path: string;
  created: boolean;
}

/**
 * Load or create the dashboard token at `path`.
 * On create, writes with 0600 perms. On load, re-asserts perms.
 */
export function loadOrCreateToken(path: string): TokenFile {
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim();
    if (token.length > 0) {
      try {
        chmodSync(path, 0o600);
      } catch {
        // best-effort
      }
      return { token, path, created: false };
    }
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = generateToken();
  writeFileSync(path, token + '\n', { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
  return { token, path, created: true };
}

function tokensEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export interface AuthOptions {
  mode: 'token' | 'none';
  token: string;
  hostAllowlist: readonly string[];
  /**
   * Hosts considered loopback — checked first on the Host header and the
   * underlying socket remote address. Always allowed regardless of config.
   */
  loopbackHosts?: readonly string[];
  /**
   * When true, issue the `Secure` flag on the session cookie. Enable if the
   * dashboard is fronted by TLS (Caddy etc.).
   */
  secureCookie?: boolean;
}

const DEFAULT_LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hostHeader(req: Request): string {
  const h = req.headers.host ?? '';
  // Strip port, if any.
  const idx = h.lastIndexOf(':');
  if (idx > 0 && !h.includes(']:')) return h.slice(0, idx);
  return h;
}

function hostAllowed(req: Request, opts: AuthOptions): boolean {
  const loopback = opts.loopbackHosts ?? DEFAULT_LOOPBACK;
  const host = hostHeader(req).toLowerCase();
  if (!host) return false;
  if (loopback.includes(host)) return true;
  return opts.hostAllowlist.some((h) => h.toLowerCase() === host);
}

function extractToken(req: Request): string | null {
  // Authorization: Bearer <token>
  const authz = req.headers.authorization;
  if (typeof authz === 'string' && authz.startsWith('Bearer ')) {
    return authz.slice(7).trim();
  }
  // Cookie
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const parsed = parseCookie(cookieHeader);
    const t = parsed[COOKIE_NAME];
    if (typeof t === 'string' && t.length > 0) return t;
  }
  // ?token= query (only for GET — used to bootstrap the cookie)
  if (req.method === 'GET' && typeof req.query['token'] === 'string') {
    return req.query['token'];
  }
  return null;
}

/**
 * Middleware: reject requests that don't match the host allowlist with 421.
 * Applied to every request (even `/health`), because DNS-rebinding protection
 * has to be unconditional to be useful.
 */
export function hostAllowlistMiddleware(opts: AuthOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (hostAllowed(req, opts)) return next();
    res.status(421).type('text/plain').send('misdirected host');
  };
}

/**
 * Middleware that guards authenticated routes.
 * - In `mode: 'none'`, short-circuits as authorized.
 * - In `mode: 'token'`, requires the token via Authorization or cookie.
 * - If `?token=<t>` is present on a GET, sets the cookie and redirects to the
 *   same path without the query (one-time auth handoff).
 * - State-changing methods require the token to be presented AND same-origin.
 */
export function authMiddleware(opts: AuthOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (opts.mode === 'none') return next();

    // ?token= on GET → set cookie and redirect to sanitized URL.
    const queryToken = req.method === 'GET' ? req.query['token'] : undefined;
    if (typeof queryToken === 'string') {
      if (!tokensEqual(queryToken, opts.token)) {
        res.status(401).type('text/plain').send('invalid token');
        return;
      }
      res.setHeader(
        'set-cookie',
        serializeCookie(COOKIE_NAME, opts.token, {
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
          maxAge: 60 * 60 * 24 * 30,
          secure: Boolean(opts.secureCookie),
        }),
      );
      // Strip the token from the redirected URL.
      const u = new URL(req.originalUrl, 'http://placeholder');
      u.searchParams.delete('token');
      const redirect = u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : '');
      res.redirect(302, redirect);
      return;
    }

    const presented = extractToken(req);
    if (!presented || !tokensEqual(presented, opts.token)) {
      res.status(401).type('text/plain').send('unauthorized');
      return;
    }

    if (STATE_CHANGING.has(req.method)) {
      // Require same-origin. Browsers set Sec-Fetch-Site on all modern versions;
      // 'same-origin' or 'none' are acceptable, 'cross-site' / 'same-site' are not.
      const sfs = req.headers['sec-fetch-site'];
      if (typeof sfs === 'string' && sfs !== 'same-origin' && sfs !== 'none') {
        res.status(403).type('text/plain').send('cross-site forbidden');
        return;
      }
      // Origin/Referer fallback for older browsers / non-browser clients.
      const origin = req.headers.origin;
      if (typeof origin === 'string' && origin.length > 0) {
        const hostH = hostHeader(req);
        try {
          const o = new URL(origin);
          if (o.hostname.toLowerCase() !== hostH.toLowerCase()) {
            res.status(403).type('text/plain').send('cross-origin forbidden');
            return;
          }
        } catch {
          res.status(403).type('text/plain').send('invalid origin');
          return;
        }
      }
    }

    next();
  };
}

/**
 * Build a one-time URL that sets the cookie and lands on the dashboard.
 */
export function buildLoginUrl(opts: {
  bind: string;
  port: number;
  token: string;
  scheme?: 'http' | 'https';
  path?: string;
}): string {
  const scheme = opts.scheme ?? 'http';
  const host = opts.bind === '0.0.0.0' || opts.bind === '::' ? 'localhost' : opts.bind;
  const portPart =
    (scheme === 'http' && opts.port === 80) || (scheme === 'https' && opts.port === 443)
      ? ''
      : `:${opts.port}`;
  const path = opts.path ?? '/';
  return `${scheme}://${host}${portPart}${path}?token=${encodeURIComponent(opts.token)}`;
}
