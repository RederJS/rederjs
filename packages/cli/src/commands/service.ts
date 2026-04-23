import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pidPathFor } from '../paths.js';
import { loadConfigContext } from '../config-loader.js';
import { hasRederUserUnit } from './systemd.js';

export interface ServiceResult {
  method: 'systemctl' | 'direct';
  ok: boolean;
  detail: string;
}

export function runStart(opts: { configPath?: string } = {}): ServiceResult {
  const ctx = loadConfigContext(opts.configPath);
  const pidPath = pidPathFor(ctx.runtimeDir);
  if (existsSync(pidPath)) {
    const pid = Number(readFileSync(pidPath, 'utf8').trim());
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
        return { method: 'direct', ok: false, detail: `already running (pid ${pid})` };
      } catch {
        // stale
      }
    }
  }
  if (hasRederUserUnit()) {
    const res = spawnSync('systemctl', ['--user', 'start', 'reder'], { stdio: 'inherit' });
    return {
      method: 'systemctl',
      ok: res.status === 0,
      detail: res.status === 0 ? 'started via systemctl --user' : `systemctl failed: ${res.status}`,
    };
  }
  // Direct fork
  const child = spawn('rederd', ['--config', ctx.configPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { method: 'direct', ok: true, detail: `forked rederd (pid ${child.pid ?? 'unknown'})` };
}

export function runStop(opts: { configPath?: string } = {}): ServiceResult {
  const ctx = loadConfigContext(opts.configPath);
  if (hasRederUserUnit()) {
    const res = spawnSync('systemctl', ['--user', 'stop', 'reder'], { stdio: 'inherit' });
    if (res.status === 0) {
      return { method: 'systemctl', ok: true, detail: 'stopped via systemctl --user' };
    }
  }
  const pidPath = pidPathFor(ctx.runtimeDir);
  if (!existsSync(pidPath)) {
    return { method: 'direct', ok: false, detail: 'no pid file; daemon not running?' };
  }
  const pid = Number(readFileSync(pidPath, 'utf8').trim());
  if (!Number.isFinite(pid)) {
    return { method: 'direct', ok: false, detail: `invalid pid in ${pidPath}` };
  }
  try {
    process.kill(pid, 'SIGTERM');
    return { method: 'direct', ok: true, detail: `sent SIGTERM to pid ${pid}` };
  } catch (err) {
    return { method: 'direct', ok: false, detail: (err as Error).message };
  }
}

export function runRestart(opts: { configPath?: string } = {}): ServiceResult {
  runStop(opts);
  // Give the daemon a moment to release the lock before we restart.
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    try {
      const ctx = loadConfigContext(opts.configPath);
      if (!existsSync(pidPathFor(ctx.runtimeDir))) break;
    } catch {
      break;
    }
  }
  return runStart(opts);
}
