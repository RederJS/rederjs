import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfigContext } from '../config-loader.js';

const TOKEN_BYTES = 32;
const TOKEN_PREFIX = 'rdr_web_';

function generateRawToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
}

function hashTokenHex(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function writeTokenHashAtomic(path: string, hashHex: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, hashHex + '\n', { mode: 0o600 });
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

function buildBootstrapUrl(bind: string, port: number, token: string): string {
  const host = bind === '0.0.0.0' || bind === '::' ? 'localhost' : bind;
  return `http://${host}:${port}/?token=${encodeURIComponent(token)}`;
}

export interface DashboardUrlResult {
  url: string;
  token_path: string;
  auth: 'token' | 'none';
  /** True iff the token file is in the legacy raw-token format. */
  legacy_token_format?: boolean;
}

interface WebAdapterConfigShape {
  bind?: string;
  port?: number;
  auth?: 'token' | 'none';
  token_path?: string;
}

const HASH_HEX_LEN = 64;
const HEX_RE = /^[0-9a-f]+$/i;

function isHashedFormat(content: string): boolean {
  return content.length === HASH_HEX_LEN && HEX_RE.test(content);
}

function resolveWebTokenPath(opts: { configPath?: string }): {
  bind: string;
  port: number;
  authMode: 'token' | 'none';
  tokenPath: string;
  dataDir: string;
} {
  const ctx = loadConfigContext(opts.configPath);
  const webCfg = ctx.config.adapters['web'];
  if (!webCfg || !webCfg.enabled) {
    throw new Error(
      "adapter 'web' is not enabled in config. Enable it under adapters.web to use the dashboard.",
    );
  }
  const raw = (webCfg.config ?? {}) as WebAdapterConfigShape;
  const bind = raw.bind ?? '127.0.0.1';
  const port = raw.port ?? 7781;
  const authMode = raw.auth ?? 'token';
  const tokenPath = raw.token_path ?? join(ctx.dataDir, 'dashboard.token');
  return { bind, port, authMode, tokenPath, dataDir: ctx.dataDir };
}

/**
 * Infer the dashboard URL from the configured web adapter. Reads the persisted
 * token file (`~/.local/share/reder/dashboard.token` by default) and prints a
 * one-time login URL that primes the browser cookie.
 *
 * If the token file is in the new hashed-at-rest format (a 64-char hex
 * digest), the raw token is unrecoverable from disk — this command errors
 * with instructions to rotate. The user must run
 * `reder dashboard rotate-token` and capture the URL it prints.
 */
export function runDashboardUrl(opts: { configPath?: string } = {}): DashboardUrlResult {
  const { bind, port, authMode, tokenPath } = resolveWebTokenPath(opts);

  if (authMode === 'none') {
    const host = bind === '0.0.0.0' || bind === '::' ? 'localhost' : bind;
    return {
      url: `http://${host}:${port}/`,
      token_path: tokenPath,
      auth: 'none',
    };
  }

  if (!existsSync(tokenPath)) {
    throw new Error(
      `Dashboard token not found at ${tokenPath}. Start the daemon at least once to generate it.`,
    );
  }
  const content = readFileSync(tokenPath, 'utf8').trim();
  if (!content) {
    throw new Error(`Dashboard token file at ${tokenPath} is empty.`);
  }
  if (isHashedFormat(content)) {
    throw new Error(
      [
        `Dashboard token at ${tokenPath} is stored as a hash and the raw value is no longer recoverable.`,
        `Run \`reder dashboard rotate-token\` to mint a new token and print its one-time URL.`,
      ].join('\n'),
    );
  }
  const host = bind === '0.0.0.0' || bind === '::' ? 'localhost' : bind;
  return {
    url: `http://${host}:${port}/?token=${encodeURIComponent(content)}`,
    token_path: tokenPath,
    auth: 'token',
    legacy_token_format: true,
  };
}

export function formatDashboardUrl(r: DashboardUrlResult): string {
  if (r.auth === 'none') {
    return `Dashboard: ${r.url}  (auth disabled)`;
  }
  const lines = [`Dashboard: ${r.url}`, `Token file: ${r.token_path}`];
  if (r.legacy_token_format === true) {
    lines.push(
      `WARNING: token file is in the legacy raw format. Rotate with \`reder dashboard rotate-token\` to upgrade.`,
    );
  }
  return lines.join('\n');
}

export interface DashboardRotateResult {
  url: string;
  token_path: string;
  /** True when an existing token file was replaced; false on a fresh install. */
  rotated: boolean;
  /** Hint emitted when the daemon may still be using the previous token. */
  restart_hint: string;
}

/**
 * Generate a new dashboard token, write its hashed form to disk, and return
 * the one-time login URL. The previous token (if any) is no longer accepted
 * after the daemon next restarts; a running daemon keeps accepting the old
 * token until restarted.
 */
export function runDashboardRotateToken(opts: { configPath?: string }): DashboardRotateResult {
  const { bind, port, authMode, tokenPath } = resolveWebTokenPath(opts);

  if (authMode !== 'token') {
    throw new Error(
      `Cannot rotate token: adapter 'web' is configured with auth: '${authMode}'. Set auth: token in reder.config.yaml first.`,
    );
  }

  const existed = existsSync(tokenPath);
  if (existed) {
    // Best-effort cleanup of the previous file; the atomic write below would
    // replace it anyway, but explicit unlink makes the intent unambiguous to
    // anyone tailing strace or auditing the filesystem journal.
    try {
      unlinkSync(tokenPath);
    } catch {
      // ignore — writeTokenHashAtomic will create it
    }
  }
  const rawToken = generateRawToken();
  const hashHex = hashTokenHex(rawToken);
  writeTokenHashAtomic(tokenPath, hashHex);
  const url = buildBootstrapUrl(bind, port, rawToken);
  return {
    url,
    token_path: tokenPath,
    rotated: existed,
    restart_hint: 'Run `reder restart` for the daemon to pick up the new token.',
  };
}

export function formatDashboardRotateToken(r: DashboardRotateResult): string {
  const verb = r.rotated ? 'Rotated' : 'Generated';
  return [
    `${verb} dashboard token at ${r.token_path}`,
    `Dashboard: ${r.url}`,
    r.restart_hint,
    `(The raw token above is shown only once — copy the URL now.)`,
  ].join('\n');
}
