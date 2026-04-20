import { mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from 'pino';

export class AlreadyRunningError extends Error {
  override readonly name = 'AlreadyRunningError';
  constructor(public readonly existingPid: number, public readonly pidPath: string) {
    super(`rederd already running (pid ${existingPid}) per ${pidPath}`);
  }
}

/**
 * Acquire an exclusive PID lock file. Fails loudly if another process already holds it.
 */
export function acquirePidLock(pidPath: string): () => void {
  mkdirSync(dirname(pidPath), { recursive: true });
  try {
    const fd = openSync(pidPath, 'wx'); // O_CREAT | O_EXCL
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return () => {
      try {
        unlinkSync(pidPath);
      } catch {
        // ignore
      }
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;
    const raw = readFileSync(pidPath, 'utf8').trim();
    const existing = Number(raw);
    if (!Number.isFinite(existing) || existing <= 0) {
      // stale lock file with bad content — remove and retry
      unlinkSync(pidPath);
      return acquirePidLock(pidPath);
    }
    // Check if process is alive
    try {
      process.kill(existing, 0);
    } catch (sigErr) {
      const sigCode = (sigErr as NodeJS.ErrnoException).code;
      if (sigCode === 'ESRCH') {
        // stale — process is gone, remove and retry
        unlinkSync(pidPath);
        return acquirePidLock(pidPath);
      }
      // EPERM: process exists but not ours — still means it's running
    }
    throw new AlreadyRunningError(existing, pidPath);
  }
}

export interface ShutdownOptions {
  timeoutMs?: number;
  logger?: Logger;
}

export function installSignalHandlers(
  stop: () => Promise<void>,
  opts: ShutdownOptions = {},
): () => void {
  const { timeoutMs = 10_000, logger } = opts;
  let shuttingDown = false;

  const handler = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      logger?.warn({ signal }, 'second signal received; forcing exit');
      process.exit(1);
    }
    shuttingDown = true;
    logger?.info({ signal }, 'shutdown signal received');
    const timer = setTimeout(() => {
      logger?.error({ signal, timeoutMs }, 'graceful shutdown timed out; exiting 1');
      process.exit(1);
    }, timeoutMs);
    timer.unref();
    stop()
      .then(() => {
        clearTimeout(timer);
        process.exit(0);
      })
      .catch((err) => {
        clearTimeout(timer);
        logger?.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  };

  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);

  return () => {
    process.off('SIGTERM', handler);
    process.off('SIGINT', handler);
  };
}
