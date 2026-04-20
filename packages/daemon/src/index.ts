#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bootstrap } from './bootstrap.js';
import { acquirePidLock, installSignalHandlers, AlreadyRunningError } from './lifecycle.js';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    strict: false,
  });

  if (values.help) {
    process.stdout.write(
      'Usage: rederd [--config PATH]\n\n' +
        'Environment:\n' +
        '  REDER_CONFIG  path to reder.config.yaml\n',
    );
    process.exit(0);
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  const configPath =
    (values.config as string | undefined) ??
    process.env['REDER_CONFIG'] ??
    join(homedir(), '.config', 'reder', 'reder.config.yaml');

  let result;
  try {
    result = await bootstrap({ configPath, daemonVersion: VERSION });
  } catch (err) {
    process.stderr.write(`rederd: bootstrap failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const runtimeDir = result.config.runtime.runtime_dir.startsWith('~/')
    ? join(homedir(), result.config.runtime.runtime_dir.slice(2))
    : result.config.runtime.runtime_dir;
  let releaseLock: () => void;
  try {
    releaseLock = acquirePidLock(join(runtimeDir, 'rederd.pid'));
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      process.stderr.write(`rederd: ${err.message}\n`);
      await result.stop();
      process.exit(1);
    }
    throw err;
  }

  installSignalHandlers(
    async () => {
      await result.stop();
      releaseLock();
    },
    { logger: result.logger, timeoutMs: 10_000 },
  );

  result.logger.info({ version: VERSION }, 'rederd ready');

  // Block main task; signal handlers will exit.
  await new Promise<never>(() => {});
}

main().catch((err) => {
  process.stderr.write(`rederd: fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
