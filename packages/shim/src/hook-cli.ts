#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createConnection } from 'node:net';
import { encode } from '@rederjs/core/ipc/codec';

const HOOK_NAMES = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'] as const;
type HookName = (typeof HOOK_NAMES)[number];

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
    const timer = setTimeout(() => {
      try { process.stdin.pause(); } catch { /* ignore */ }
      resolve(safeParse(Buffer.concat(chunks).toString('utf8')));
    }, timeoutMs);
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(safeParse(Buffer.concat(chunks).toString('utf8')));
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

  const payload = await readStdinJson(250);

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
      try { socket.destroy(); } catch { /* ignore */ }
      resolve();
    };
    const timer = setTimeout(finish, 1500);
    socket.once('connect', () => {
      socket.write(frame, () => {
        try { socket.end(); } catch { /* ignore */ }
      });
    });
    socket.once('close', () => {
      clearTimeout(timer);
      finish();
    });
    socket.once('error', () => {
      // Daemon not running — exit silently to avoid breaking Claude hooks.
      clearTimeout(timer);
      finish();
    });
  });

  process.exit(0);
}

main().catch(() => {
  // Swallow unexpected errors — hooks must not fail the user's Claude session.
  process.exit(0);
});
