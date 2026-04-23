#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createConnection } from 'node:net';
import { encode } from '@rederjs/core/ipc/codec';

const HOOK_NAMES = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'] as const;
type HookName = (typeof HOOK_NAMES)[number];

// Claude Code usually closes stdin promptly; this bounds hangs without losing complete payloads.
const STDIN_TIMEOUT_MS = 250;
// Covers Unix-socket connect + single-frame round-trip well below Claude's per-hook budget.
const SOCKET_TIMEOUT_MS = 1500;
// Cap stdin payload size to keep hook invocation memory bounded.
const MAX_STDIN_BYTES = 64 * 1024;

function debug(msg: string): void {
  if (process.env.REDER_HOOK_DEBUG) {
    try {
      process.stderr.write(`reder-hook: ${msg}\n`);
    } catch {
      /* ignore */
    }
  }
}

function die(msg: string): never {
  process.stderr.write(`reder-hook: ${msg}\n`);
  process.exit(2);
}

function isHookName(v: string | undefined): v is HookName {
  return v !== undefined && (HOOK_NAMES as readonly string[]).includes(v);
}

async function readStdinJson(timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    const timer = setTimeout(() => {
      try {
        process.stdin.pause();
      } catch {
        /* ignore */
      }
      resolve(capped ? {} : safeParse(Buffer.concat(chunks).toString('utf8')));
    }, timeoutMs);
    process.stdin.on('data', (c: Buffer) => {
      if (capped) return;
      total += c.length;
      if (total > MAX_STDIN_BYTES) {
        capped = true;
        try {
          process.stdin.pause();
        } catch {
          /* ignore */
        }
        return;
      }
      chunks.push(c);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(capped ? {} : safeParse(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

function safeParse(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  try {
    const out = JSON.parse(trimmed) as unknown;
    return out && typeof out === 'object' && !Array.isArray(out)
      ? (out as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'session-id': { type: 'string' },
      socket: { type: 'string' },
      token: { type: 'string' },
      hook: { type: 'string' },
    },
    strict: false,
  });

  if (!values['session-id']) die('missing --session-id');
  if (!values.socket) die('missing --socket');
  if (!values.token) die('missing --token');
  if (!isHookName(values.hook as string | undefined)) die('invalid or missing --hook');

  const payload = await readStdinJson(STDIN_TIMEOUT_MS);

  const frame = encode({
    kind: 'hook_event',
    session_id: values['session-id'] as string,
    shim_token: values.token as string,
    hook: values.hook as HookName,
    timestamp: new Date().toISOString(),
    payload,
  });

  await new Promise<void>((resolve) => {
    const socket = createConnection({ path: values.socket as string });
    const finish = (): void => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve();
    };
    const timer = setTimeout(finish, SOCKET_TIMEOUT_MS);
    socket.once('connect', () => {
      socket.write(frame, () => {
        try {
          socket.end();
        } catch {
          /* ignore */
        }
      });
    });
    socket.once('close', () => {
      clearTimeout(timer);
      finish();
    });
    socket.once('error', (err) => {
      // Daemon not running — exit silently to avoid breaking Claude hooks.
      debug(`socket error: ${(err as Error).message}`);
      clearTimeout(timer);
      finish();
    });
  });

  process.exit(0);
}

main().catch((err) => {
  // Swallow unexpected errors — hooks must not fail the user's Claude session.
  debug(`fatal: ${(err as Error).stack ?? String(err)}`);
  process.exit(0);
});
