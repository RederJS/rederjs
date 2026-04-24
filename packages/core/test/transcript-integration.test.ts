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
import { createBinding } from '../src/pairing.js';
import { createSession } from '../src/sessions.js';
import { FakeAdapter } from './fixtures/fake-adapter.js';

type Emit = (event: string, ...args: unknown[]) => boolean;

interface SentFrame {
  sessionId: string;
  msg: { kind: string } & Record<string, unknown>;
}

function fakeIpcServer(): { server: IpcServer; emit: Emit; sent: SentFrame[] } {
  const ee = new EventEmitter();
  const sent: SentFrame[] = [];
  const server: IpcServer = {
    socketPath: '/tmp/fake',
    on: ((event: string, listener: (...a: unknown[]) => void) => {
      ee.on(event, listener);
    }) as IpcServer['on'],
    off: ((event: string, listener: (...a: unknown[]) => void) => {
      ee.off(event, listener);
    }) as IpcServer['off'],
    sendToSession: (sessionId, msg) => {
      sent.push({ sessionId, msg: msg as SentFrame['msg'] });
      return true;
    },
    isSessionConnected: () => true,
    close: async () => {},
  };
  return { server, emit: ee.emit.bind(ee) as Emit, sent };
}

let dir: string;
let db: DatabaseHandle;
let tPath: string;
let router: Router;
let emit: Emit;
let sent: SentFrame[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tx-'));
  db = openDatabase(':memory:');
  tPath = join(dir, 'session.jsonl');
  await createSession(db.raw, 's1', 'session 1');
  await createSession(db.raw, 's-other', 'session other');
  const { server, emit: e, sent: s } = fakeIpcServer();
  emit = e;
  sent = s;
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
  async function fireTurn(
    prompt: string,
    reply: string,
    t = '2026-04-24T12:00:02Z',
  ): Promise<void> {
    emit('hook_event', {
      session_id: 's1',
      hook: 'UserPromptSubmit',
      timestamp: t,
      payload: { transcript_path: tPath, prompt },
    });
    await tick();
    writeFileSync(tPath, USER('u1', prompt) + ASSISTANT('a1', reply));
    emit('hook_event', {
      session_id: 's1',
      hook: 'Stop',
      timestamp: t,
      payload: { transcript_path: tPath },
    });
    await tick();
  }

  it('persists tmux prompt and reply across the hook pair', async () => {
    await fireTurn('hello', 'hi there');

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
    await fireTurn('hello', 'hi');
    emit('hook_event', {
      session_id: 's1',
      hook: 'Stop',
      timestamp: '2026-04-24T12:00:03Z',
      payload: { transcript_path: tPath },
    });
    await tick();

    const inboundCount = (
      db.raw.prepare("SELECT COUNT(*) AS c FROM inbound_messages WHERE adapter='local'").get() as {
        c: number;
      }
    ).c;
    const outboundCount = (
      db.raw.prepare("SELECT COUNT(*) AS c FROM outbound_messages WHERE adapter='local'").get() as {
        c: number;
      }
    ).c;
    expect(inboundCount).toBe(1);
    expect(outboundCount).toBe(1);
  });

  it('emits router events so SSE subscribers refresh live', async () => {
    const received: Array<{ event: string; messageId: string; adapter: string }> = [];
    router.events.on('inbound.persisted', (p) =>
      received.push({ event: 'inbound.persisted', messageId: p.messageId, adapter: p.adapter }),
    );
    router.events.on('outbound.persisted', (p) =>
      received.push({ event: 'outbound.persisted', messageId: p.messageId, adapter: p.adapter }),
    );

    await fireTurn('hello', 'hi');

    expect(received.map((r) => ({ event: r.event, adapter: r.adapter }))).toEqual([
      { event: 'inbound.persisted', adapter: 'local' },
      { event: 'outbound.persisted', adapter: 'local' },
    ]);
  });

  it('does not re-emit on idempotent replay', async () => {
    await fireTurn('hello', 'hi');

    let counted = 0;
    router.events.on('inbound.persisted', () => counted++);
    router.events.on('outbound.persisted', () => counted++);

    // Same hook pair, same offsets — nothing new should fire.
    emit('hook_event', {
      session_id: 's1',
      hook: 'UserPromptSubmit',
      timestamp: '2026-04-24T12:00:02Z',
      payload: { transcript_path: tPath, prompt: 'hello' },
    });
    await tick();
    emit('hook_event', {
      session_id: 's1',
      hook: 'Stop',
      timestamp: '2026-04-24T12:00:02Z',
      payload: { transcript_path: tPath },
    });
    await tick();
    expect(counted).toBe(0);
  });

  it('captures the user prompt from UserPromptSubmit payload (transcript not yet written)', async () => {
    // Claude Code writes the JSONL entry *after* the UserPromptSubmit hook
    // fires — so the transcript is empty at that moment. We rely on
    // payload.prompt for the eager insert.
    writeFileSync(tPath, '');
    emit('hook_event', {
      session_id: 's1',
      hook: 'UserPromptSubmit',
      timestamp: '2026-04-24T12:00:02Z',
      payload: { transcript_path: tPath, prompt: 'hello' },
    });
    await tick();

    const inbound = db.raw
      .prepare("SELECT content FROM inbound_messages WHERE adapter='local'")
      .all() as Array<{ content: string }>;
    expect(inbound.map((r) => r.content)).toEqual(['hello']);

    // Now the JSONL catches up: Claude writes the user line then the
    // assistant line, and Stop fires.
    writeFileSync(tPath, USER('u1', 'hello') + ASSISTANT('a1', 'hi'));
    emit('hook_event', {
      session_id: 's1',
      hook: 'Stop',
      timestamp: '2026-04-24T12:00:03Z',
      payload: { transcript_path: tPath },
    });
    await tick();

    const outbound = db.raw
      .prepare("SELECT content FROM outbound_messages WHERE adapter='local'")
      .all() as Array<{ content: string }>;
    expect(outbound.map((r) => r.content)).toEqual(['hi']);
    // User prompt stays at a single row — the Stop-time tail must skip
    // the user JSONL entry, since it was already captured from payload.
    const inboundCount = (
      db.raw.prepare("SELECT COUNT(*) AS c FROM inbound_messages WHERE adapter='local'").get() as {
        c: number;
      }
    ).c;
    expect(inboundCount).toBe(1);
  });

  it('falls back to transcript user entry when UserPromptSubmit did not capture', async () => {
    // Simulates a missed/truncated UserPromptSubmit: no eager insert happens,
    // so the Stop-time tail must still surface the prompt from the JSONL.
    writeFileSync(tPath, USER('u1', 'long prompt') + ASSISTANT('a1', 'reply'));
    emit('hook_event', {
      session_id: 's1',
      hook: 'Stop',
      timestamp: '2026-04-24T12:00:03Z',
      payload: { transcript_path: tPath },
    });
    await tick();

    const inbound = db.raw
      .prepare("SELECT content FROM inbound_messages WHERE adapter='local'")
      .all() as Array<{ content: string }>;
    expect(inbound.map((r) => r.content)).toEqual(['long prompt']);
  });

  it('ignores UserPromptSubmit payloads that wrap adapter-relayed content', async () => {
    // When a web/telegram prompt reaches Claude via MCP, UserPromptSubmit
    // fires with a prompt wrapped in <channel source="reder"> — the adapter's
    // own inbound row is already canonical; we must not write a duplicate.
    emit('hook_event', {
      session_id: 's1',
      hook: 'UserPromptSubmit',
      timestamp: '2026-04-24T12:00:02Z',
      payload: {
        transcript_path: tPath,
        prompt: '<channel source="reder">hi from web</channel>',
      },
    });
    await tick();

    const inbound = db.raw
      .prepare("SELECT content FROM inbound_messages WHERE adapter='local'")
      .all();
    expect(inbound).toHaveLength(0);
  });

  it('does not route adapter-less local inbound as a reply recipient', async () => {
    // After a tmux-captured prompt lands in inbound_messages with adapter='local',
    // a subsequent reply_tool_call without in_reply_to must not resolve the
    // recipient to 'local' (no adapter is registered under that name).
    emit('hook_event', {
      session_id: 's1',
      hook: 'UserPromptSubmit',
      timestamp: '2026-04-24T12:00:02Z',
      payload: { transcript_path: tPath, prompt: 'hi' },
    });
    await tick();

    emit('reply_tool_call', {
      session_id: 's1',
      request_id: 'r1',
      content: 'claude reply',
      meta: {},
      files: [],
    });
    await tick();

    const results = sent.filter((f) => f.msg.kind === 'reply_tool_result');
    expect(results).toHaveLength(1);
    expect(results[0]?.msg['success']).toBe(false);
    expect(results[0]?.msg['error']).toBe('no recipient bound to session');
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

  it('fans tmux-originated assistant replies out to every paired non-local binding', async () => {
    const telegram = new FakeAdapter('telegram');
    const slack = new FakeAdapter('slack');
    router.registerAdapter('telegram', { adapter: telegram });
    router.registerAdapter('slack', { adapter: slack });
    createBinding(db.raw, { sessionId: 's1', adapter: 'telegram', senderId: 'tg-user-1' });
    createBinding(db.raw, { sessionId: 's1', adapter: 'telegram', senderId: 'tg-user-2' });
    createBinding(db.raw, { sessionId: 's1', adapter: 'slack', senderId: 'slack-user' });
    // Binding for another session should not receive anything.
    createBinding(db.raw, { sessionId: 's-other', adapter: 'telegram', senderId: 'tg-user-3' });

    writeFileSync(tPath, ASSISTANT('a1', 'broadcasting'));
    emit('hook_event', {
      session_id: 's1',
      hook: 'Stop',
      timestamp: '2026-04-24T12:00:03Z',
      payload: { transcript_path: tPath },
    });
    await tick();
    await tick();

    expect(telegram.sent.map((m) => ({ recipient: m.recipient, content: m.content }))).toEqual([
      { recipient: 'tg-user-1', content: 'broadcasting' },
      { recipient: 'tg-user-2', content: 'broadcasting' },
    ]);
    expect(slack.sent.map((m) => ({ recipient: m.recipient, content: m.content }))).toEqual([
      { recipient: 'slack-user', content: 'broadcasting' },
    ]);

    // Dashboard still sees only the canonical `local` row — no per-binding
    // duplicates in outbound_messages.
    const localOutboundCount = (
      db.raw.prepare("SELECT COUNT(*) AS c FROM outbound_messages WHERE adapter='local'").get() as {
        c: number;
      }
    ).c;
    expect(localOutboundCount).toBe(1);
    const nonLocalOutboundCount = (
      db.raw
        .prepare("SELECT COUNT(*) AS c FROM outbound_messages WHERE adapter!='local'")
        .get() as {
        c: number;
      }
    ).c;
    expect(nonLocalOutboundCount).toBe(0);
  });

  it('does not fan out when no non-local bindings exist', async () => {
    const telegram = new FakeAdapter('telegram');
    router.registerAdapter('telegram', { adapter: telegram });

    writeFileSync(tPath, ASSISTANT('a1', 'hi'));
    emit('hook_event', {
      session_id: 's1',
      hook: 'Stop',
      timestamp: '2026-04-24T12:00:03Z',
      payload: { transcript_path: tPath },
    });
    await tick();

    expect(telegram.sent).toHaveLength(0);
  });

  it('does not fan out user prompts, only assistant replies', async () => {
    const telegram = new FakeAdapter('telegram');
    router.registerAdapter('telegram', { adapter: telegram });
    createBinding(db.raw, { sessionId: 's1', adapter: 'telegram', senderId: 'tg-user-1' });

    emit('hook_event', {
      session_id: 's1',
      hook: 'UserPromptSubmit',
      timestamp: '2026-04-24T12:00:02Z',
      payload: { transcript_path: tPath, prompt: 'tmux prompt' },
    });
    await tick();

    expect(telegram.sent).toHaveLength(0);
  });

  it('swallows fan-out send errors so the main capture continues', async () => {
    const telegram = new FakeAdapter('telegram');
    telegram.nextSendBehavior = 'terminal';
    router.registerAdapter('telegram', { adapter: telegram });
    createBinding(db.raw, { sessionId: 's1', adapter: 'telegram', senderId: 'tg-user' });

    writeFileSync(tPath, ASSISTANT('a1', 'reply'));
    emit('hook_event', {
      session_id: 's1',
      hook: 'Stop',
      timestamp: '2026-04-24T12:00:03Z',
      payload: { transcript_path: tPath },
    });
    await tick();
    await tick();

    // Local row still written despite the fan-out failure.
    const local = db.raw
      .prepare("SELECT content FROM outbound_messages WHERE adapter='local'")
      .all() as Array<{ content: string }>;
    expect(local.map((r) => r.content)).toEqual(['reply']);
    expect(telegram.sent).toHaveLength(1);
  });
});
