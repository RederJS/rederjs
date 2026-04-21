import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfigContext } from '../config-loader.js';

export interface DashboardUrlResult {
  url: string;
  token_path: string;
  auth: 'token' | 'none';
}

interface WebAdapterConfigShape {
  bind?: string;
  port?: number;
  auth?: 'token' | 'none';
  token_path?: string;
}

/**
 * Infer the dashboard URL from the configured web adapter. Reads the persisted
 * token file (`~/.local/share/reder/dashboard.token` by default) and prints a
 * one-time login URL that primes the browser cookie.
 */
export function runDashboardUrl(opts: { configPath?: string } = {}): DashboardUrlResult {
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
  const token = readFileSync(tokenPath, 'utf8').trim();
  if (!token) {
    throw new Error(`Dashboard token file at ${tokenPath} is empty.`);
  }
  const host = bind === '0.0.0.0' || bind === '::' ? 'localhost' : bind;
  return {
    url: `http://${host}:${port}/?token=${encodeURIComponent(token)}`,
    token_path: tokenPath,
    auth: 'token',
  };
}

export function formatDashboardUrl(r: DashboardUrlResult): string {
  if (r.auth === 'none') {
    return `Dashboard: ${r.url}  (auth disabled)`;
  }
  return `Dashboard: ${r.url}\nToken file: ${r.token_path}`;
}
