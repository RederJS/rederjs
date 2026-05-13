import { homedir } from 'node:os';
import { join } from 'node:path';

export function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

export function defaultConfigPath(): string {
  return join(homedir(), '.config', 'reder', 'reder.config.yaml');
}

export function defaultEnvPath(): string {
  return join(homedir(), '.config', 'reder', 'reder.env');
}

export function defaultRuntimeDir(): string {
  return join(homedir(), '.local', 'share', 'reder');
}

export function defaultDataDir(): string {
  return join(defaultRuntimeDir(), 'data');
}

export function socketPathFor(runtimeDir: string): string {
  return join(runtimeDir, 'rederd.sock');
}

export function pidPathFor(runtimeDir: string): string {
  return join(runtimeDir, 'rederd.pid');
}

/**
 * Per-session directory under the daemon data dir. Holds artifacts (currently
 * just the shim token) that must not live in the user's project workspace.
 */
export function sessionDataDir(dataDir: string, sessionId: string): string {
  return join(dataDir, 'sessions', sessionId);
}

/**
 * File path for the per-session shim token. The shim and hook CLI read this
 * file via `--token-file` instead of receiving the secret on argv (which leaks
 * into /proc/<pid>/cmdline and `ps -ef`).
 */
export function shimTokenPathFor(dataDir: string, sessionId: string): string {
  return join(sessionDataDir(dataDir, sessionId), 'shim.token');
}
