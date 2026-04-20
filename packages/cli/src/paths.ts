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
