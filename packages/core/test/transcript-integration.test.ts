import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { openDatabase, type DatabaseHandle } from '../src/storage/db.js';
import { createRouter, type Router } from '../src/router.js';
import { createAuditLog } from '../src/audit.js';
import { createLogger } from '../src/logger.js';
import type { IpcServer } from '../src/ipc/server.js';

type Emit = (event: string, ...args: unknown[]) => boolean;

function fakeIpcServer(): { server: IpcServer; emit: Emit } {
  const ee = new EventEmitter();
  const server: IpcServer = {
    socketPath: '/tmp/fake',
    on: ((event: string, listener: (...a: unknown[]) => void) => {
      ee.on(event, listener);
    }) as IpcServer['on'],
    off: ((event: string, listener: (...a: unknown[]) => void) => {
      ee.off(event, listener);
    }) as IpcServer['off'],
    sendToSession: () => true,
    isSessionConnected: () => true,
    close: async () => {},
  };
  return { server, emit: ee.emit.bind(ee) as Emit };
}

let dir: string;
let db: DatabaseHandle;
let tPath: string;
let router: Router;
let emit: Emit;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tx-'));
  db = openDatabase(':memory:');
  tPath = join(dir, 'session.jsonl');
  const { server, emit: e } = fakeIpcServer();
  emit = e;
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  const audit = createAuditLog(dir);
  router = createRouter({ db: db.raw, ipcServer: server, logger, audit });
});
afterEach(async () => {
  await router.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const USER = (uuid: string, text: string): string =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-04-24T12:00:00Z',
    message: { role: 'user', content: text },
  }) + '\n';
const ASSISTANT = (uuid: string, text: string): string =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-04-24T12:00:01Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n';

async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('router transcript capture', () => {
  it('persists tmux prompt and reply on Stop hook', async () => {
    writeFileSync(tPath, USER('u1', 'hello') + ASSISTANT('a1', 'hi there'));

    emit('hook_event', {
      session_id: 's1',
      hook: 'Stop',
      timestamp: '2026-04-24T12:00:02Z',
      payload: { transcript_path: tPath },
    });
    await tick();

    const inbound = db.raw
      .prepare("SELECT content FROM inbound_messages WHERE adapter='local'")
      .all() as Array<{ content: string }>;
    const outbound = db.raw
      .prepare("SELECT content FROM outbound_messages WHERE adapter='local'")
      .all() as Array<{ content: string }>;
    expect(inbound.map((r) => r.content)).toEqual(['hello']);
    expect(outbound.map((r) => r.content)).toEqual(['hi there']);
  });

  it('does not double-persist when Stop fires twice with no new content', async () => {
    writeFileSync(tPath, USER('u1', 'hello') + ASSISTANT('a1', 'hi'));

    emit('hook_event', {
      session_id: 's1',
      hook: 'Stop',
      timestamp: '2026-04-24T12:00:02Z',
      payload: { transcript_path: tPath },
    });
    await tick();
    emit('hook_event', {
      session_id: 's1',
      hook: 'Stop',
      timestamp: '2026-04-24T12:00:03Z',
      payload: { transcript_path: tPath },
    });
    await tick();

    const inboundCount = (
      db.raw
        .prepare("SELECT COUNT(*) AS c FROM inbound_messages WHERE adapter='local'")
        .get() as { c: number }
    ).c;
    expect(inboundCount).toBe(1);
  });

  it('ignores adapter-relayed prompts that appear in the transcript', async () => {
    const relayed =
      JSON.stringify({
        type: 'user',
        uuid: 'u-relay',
        timestamp: '2026-04-24T12:00:00Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<channel source="reder">hi from web</channel>' }],
        },
      }) + '\n';
    writeFileSync(tPath, relayed + ASSISTANT('a1', 'replying'));

    emit('hook_event', {
      session_id: 's1',
      hook: 'Stop',
      timestamp: '2026-04-24T12:00:02Z',
      payload: { transcript_path: tPath },
    });
    await tick();

    const inbound = db.raw
      .prepare("SELECT content FROM inbound_messages WHERE adapter='local'")
      .all() as Array<{ content: string }>;
    const outbound = db.raw
      .prepare("SELECT content FROM outbound_messages WHERE adapter='local'")
      .all() as Array<{ content: string }>;
    expect(inbound).toHaveLength(0);
    expect(outbound).toHaveLength(1);
  });
});
