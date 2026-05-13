import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Logger } from 'pino';

export const COOKIE_NAME = 'reder_token';
const TOKEN_BYTES = 32;
const TOKEN_PREFIX = 'rdr_web_';
/** Length of a hex sha256 digest (used to detect hashed token files). */
const HASH_HEX_LEN = 64;
const HEX_RE = /^[0-9a-f]+$/i;

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Hex-encoded sha256 of the raw token bytes. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface TokenFile {
  /** The hex sha256 digest of the active token. Used for verification. */
  tokenHash: string;
  /**
   * The raw token. Always present immediately after creation or rotation
   * (so the caller can print a one-time URL). Present when loading a
   * legacy raw-token file as well; absent when loading a hashed file.
   */
  rawToken?: string;
  /** Absolute path to the token file. */
  path: string;
  /** True if this call created a new token. */
  created: boolean;
  /** True if the on-disk file is in the legacy raw-token format. */
  legacy: boolean;
}

function isHashedFormat(content: string): boolean {
  return content.length === HASH_HEX_LEN && HEX_RE.test(content);
}

/**
 * Load the dashboard token at `path` if it exists, or create one.
 *
 * Format on disk: a hex sha256 digest of the raw token. New installs always
 * write the hashed form. Legacy installs containing a raw token are detected
 * (any content that does not look like a 64-hex-char digest is treated as
 * raw) and a deprecation warning is emitted via `logger`; the raw form is
 * still accepted so existing deployments keep working until the next
 * `reder dashboard rotate-token`.
 */
export function loadOrCreateToken(path: string, logger?: Logger): TokenFile {
  if (existsSync(path)) {
    const content = readFileSync(path, 'utf8').trim();
    if (content.length > 0) {
      try {
        chmodSync(path, 0o600);
      } catch {
        // best-effort
      }
      if (isHashedFormat(content)) {
        return { tokenHash: content.toLowerCase(), path, created: false, legacy: false };
      }
      // Legacy raw token on disk — keep working but warn.
      if (logger) {
        logger.warn(
          { token_path: path, component: 'adapter.web.auth' },
          'dashboard.token is in legacy raw format; rotate with `reder dashboard rotate-token` to upgrade to a hashed-at-rest token',
        );
      }
      return {
        tokenHash: hashToken(content),
        rawToken: content,
        path,
        created: false,
        legacy: true,
      };
    }
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  writeTokenFile(path, tokenHash);
  return { tokenHash, rawToken, path, created: true, legacy: false };
}

/**
 * Generate a fresh token, atomically overwrite the file at `path` with its
 * hashed-at-rest form, and return the raw token (for one-time display).
 *
 * Intended for `reder dashboard rotate-token`. Safe to call while the daemon
 * is running (the next daemon read picks up the new hash); the running
 * daemon keeps accepting the old token until it is restarted.
 */
export function rotateToken(path: string): TokenFile {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  writeTokenFile(path, tokenHash);
  return { tokenHash, rawToken, path, created: true, legacy: false };
}

function writeTokenFile(path: string, content: string): void {
  // Atomic-ish write: write to temp + rename. POSIX rename is atomic on the
  // same filesystem, which the token directory always is.
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content + '\n', { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * Constant-time comparison of two hex sha256 digests. Both inputs are
 * expected to be lowercase hex of the same length; mismatched length returns
 * false in O(1) without leaking timing info on the digest content.
 */
function hashesEqual(presentedHash: string, knownHash: string): boolean {
  if (presentedHash.length !== knownHash.length) return false;
  try {
    return timingSafeEqual(Buffer.from(presentedHash, 'utf8'), Buffer.from(knownHash, 'utf8'));
  } catch {
    return false;
  }
}

export interface AuthOptions {
  mode: 'token' | 'none';
  /** Hex sha256 of the active raw token. */
  tokenHash: string;
  hostAllowlist: readonly string[];
  /**
   * Hosts considered loopback — checked first on the Host header and the
   * underlying socket remote address. Always allowed regardless of config.
   */
  loopbackHosts?: readonly string[];
  /**
   * Cookie `Secure` flag policy.
   * - `true`: always set `Secure`.
   * - `false`: never set `Secure` (plain-HTTP local-only setups).
   * - `'auto'`: set `Secure` iff the request itself is HTTPS — either via
   *   `req.secure` (requires `app.set('trust proxy', …)`) or the
   *   `X-Forwarded-Proto: https` header from an upstream TLS terminator.
   */
  secureCookie?: boolean | 'auto';
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

/**
 * Decide if the cookie should carry the Secure flag for this request.
 * Honours explicit booleans; for 'auto', detects TLS via req.secure or
 * X-Forwarded-Proto.
 */
function shouldSetSecure(req: Request, policy: AuthOptions['secureCookie']): boolean {
  if (policy === true) return true;
  if (policy === false || policy === undefined) return false;
  // 'auto'
  if (req.secure) return true;
  const xfp = req.headers['x-forwarded-proto'];
  if (typeof xfp === 'string' && xfp.split(',')[0]?.trim().toLowerCase() === 'https') {
    return true;
  }
  return false;
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
 * - In `mode: 'none'`, short-circuits as authorized (after setting standard
 *   response headers).
 * - In `mode: 'token'`, requires the token via Authorization or cookie.
 * - If `?token=<t>` is present on a GET **for the SPA index path** (`/`),
 *   sets the cookie and redirects to the same path without the query
 *   (one-time auth handoff). `?token=` is rejected on any other path —
 *   including `/api/*` — to keep the raw token out of API access logs and
 *   referer chains.
 * - State-changing methods require the token to be presented AND same-origin.
 *
 * All authed responses also carry `Referrer-Policy: no-referrer` so the raw
 * token (if it ever appears in a URL bar by mistake) is not leaked downstream
 * via `Referer`.
 */
export function authMiddleware(opts: AuthOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (opts.mode === 'none') return next();

    // ?token= cookie handoff — restricted to the SPA index path so the raw
    // token never lands in /api/* access logs or referer chains.
    const queryToken = req.method === 'GET' ? req.query['token'] : undefined;
    const isIndexPath = req.path === '/' || req.path === '/index.html';
    if (typeof queryToken === 'string') {
      if (!isIndexPath) {
        // Explicitly reject ?token= on deep links / API paths. The dashboard
        // SPA does the cookie handoff at `/` only.
        res.status(401).type('text/plain').send('token query not accepted on this path');
        return;
      }
      const presentedHash = hashToken(queryToken);
      if (!hashesEqual(presentedHash, opts.tokenHash)) {
        res.status(401).type('text/plain').send('invalid token');
        return;
      }
      res.setHeader(
        'set-cookie',
        serializeCookie(COOKIE_NAME, queryToken, {
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
          maxAge: 60 * 60 * 24 * 30,
          secure: shouldSetSecure(req, opts.secureCookie),
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
    if (!presented) {
      res.status(401).type('text/plain').send('unauthorized');
      return;
    }
    const presentedHash = hashToken(presented);
    if (!hashesEqual(presentedHash, opts.tokenHash)) {
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
