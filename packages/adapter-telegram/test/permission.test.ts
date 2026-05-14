import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DatabaseHandle } from '../../core/src/storage/db.js';
import { createSession } from '../../core/src/sessions.js';
import { createLogger } from '../../core/src/logger.js';
import { createAuditLog } from '../../core/src/audit.js';
import { createIpcServer, type IpcServer } from '../../core/src/ipc/server.js';
import { createRouter, type Router } from '../../core/src/router.js';
import { createAdapterStorage } from '../../core/src/storage/kv.js';
import { createBinding } from '../../core/src/pairing.js';
import type { AdapterContext } from '../../core/src/adapter.js';
import { TelegramAdapter } from '../src/index.js';
import { parsePermissionCallback, renderPermissionPrompt } from '../src/permission-prompt.js';
import { FakeTelegramTransport } from './fake-transport.js';

let dir: string;
let db: DatabaseHandle;
let router: Router;
let ipcServer: IpcServer;
let adapter: TelegramAdapter;
let fake: FakeTelegramTransport;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-tg-perm-test-'));
  db = openDatabase(join(dir, 'test.db'));
  await createSession(db.raw, 'booknerds', 'BookNerds');
  const socketPath = join(dir, 'reder.sock');
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  const audit = createAuditLog(dir);
  ipcServer = await createIpcServer({ db: db.raw, socketPath, logger });
  router = createRouter({ db: db.raw, ipcServer, logger, audit });

  fake = new FakeTelegramTransport();
  adapter = new TelegramAdapter({ transportFactory: () => fake });
  const ctx: AdapterContext = {
    logger: logger.child({ component: 'adapter.telegram' }),
    config: {
      bots: [{ token: 'fake-token', session_id: 'booknerds' }],
      long_poll_timeout_seconds: 1,
    },
    storage: createAdapterStorage(db.raw, 'telegram'),
    router,
    dataDir: dir,
    sessions: [],
  };
  await adapter.start(ctx);
  router.registerAdapter('telegram', { adapter });

  // Pre-bind a paired sender to this session; capture chat_id=42 via metadata.
  createBinding(db.raw, {
    adapter: 'telegram',
    senderId: '99',
    sessionId: 'booknerds',
    metadata: { chat_id: '42' },
  });
});

afterEach(async () => {
  await adapter.stop();
  await ipcServer.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('parsePermissionCallback', () => {
  it('parses valid perm callbacks', () => {
    expect(parsePermissionCallback('perm:r1:allow')).toEqual({
      kind: 'permission',
      requestId: 'r1',
      decision: 'allow',
    });
    expect(parsePermissionCallback('perm:xyz:deny')?.decision).toBe('deny');
    expect(parsePermissionCallback('perm:aa:always')?.decision).toBe('always');
  });

  it('returns null for malformed input', () => {
    expect(parsePermissionCallback('perm:only')).toBeNull();
    expect(parsePermissionCallback('wrong:a:b')).toBeNull();
    expect(parsePermissionCallback('perm:a:maybe')).toBeNull();
  });
});

describe('renderPermissionPrompt', () => {
  it('includes Allow/Deny/Always buttons and the tool name', () => {
    const rendered = renderPermissionPrompt({
      requestId: 'abcde',
      sessionId: 'booknerds',
      toolName: 'Bash',
      description: 'Run npm test',
      inputPreview: '{"command":"npm test"}',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(rendered.text).toContain('Bash');
    expect(rendered.markup.inline_keyboard[0]).toEqual([
      { text: '✅ Allow', callback_data: 'perm:abcde:allow' },
      { text: '❌ Deny', callback_data: 'perm:abcde:deny' },
    ]);
    expect(rendered.markup.inline_keyboard[1]?.[0]?.callback_data).toBe('perm:abcde:always');
  });
});

describe('TelegramAdapter permission relay', () => {
  it('sendPermissionPrompt delivers a message with inline keyboard to the bound chat', async () => {
    await adapter.sendPermissionPrompt({
      requestId: 'abcde',
      sessionId: 'booknerds',
      toolName: 'Bash',
      description: 'Run npm test',
      inputPreview: '{"command":"npm test"}',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.chatId).toBe(42);
    expect(fake.sent[0]!.opts?.reply_markup).toBeTruthy();
  });

  it('callback_query Allow → verdict allow forwarded to router', async () => {
    // First, fire sendPermissionPrompt (creates the message)
    await adapter.sendPermissionPrompt({
      requestId: 'abcde',
      sessionId: 'booknerds',
      toolName: 'Bash',
      description: 'x',
      inputPreview: '{}',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const verdictsReceived: Array<{ requestId: string; behavior: string; persistent?: boolean }> =
      [];
    const origIngest = router.ingestPermissionVerdict.bind(router);
    router.ingestPermissionVerdict = async (v) => {
      verdictsReceived.push({
        requestId: v.requestId,
        behavior: v.behavior,
        ...(v.persistent !== undefined ? { persistent: v.persistent } : {}),
      });
      return origIngest(v);
    };

    fake.enqueueCallbackQuery({
      update_id: 1,
      id: 'cbq1',
      chatId: 42,
      messageId: 1000,
      senderId: 99,
      data: 'perm:abcde:allow',
    });
    await waitFor(() => verdictsReceived.length > 0, 2000);
    expect(verdictsReceived[0]).toMatchObject({ requestId: 'abcde', behavior: 'allow' });
    expect(verdictsReceived[0]!.persistent).toBe(false);
    expect(fake.callbackAnswers).toHaveLength(1);
  });

  it('callback_query Always → verdict allow + persistent=true', async () => {
    await adapter.sendPermissionPrompt({
      requestId: 'r9',
      sessionId: 'booknerds',
      toolName: 'Bash',
      description: 'x',
      inputPreview: '{}',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const verdicts: Array<{ persistent?: boolean }> = [];
    const orig = router.ingestPermissionVerdict.bind(router);
    router.ingestPermissionVerdict = async (v) => {
      verdicts.push({ ...(v.persistent !== undefined ? { persistent: v.persistent } : {}) });
      return orig(v);
    };
    fake.enqueueCallbackQuery({
      update_id: 1,
      id: 'cbq',
      chatId: 42,
      messageId: 1001,
      senderId: 99,
      data: 'perm:r9:always',
    });
    await waitFor(() => verdicts.length > 0, 2000);
    expect(verdicts[0]?.persistent).toBe(true);
  });

  it('rejects callback_query from unpaired sender', async () => {
    await adapter.sendPermissionPrompt({
      requestId: 'r-unpaired',
      sessionId: 'booknerds',
      toolName: 'Bash',
      description: 'x',
      inputPreview: '{}',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const verdicts: unknown[] = [];
    const orig = router.ingestPermissionVerdict.bind(router);
    router.ingestPermissionVerdict = async (v) => {
      verdicts.push(v);
      return orig(v);
    };
    fake.enqueueCallbackQuery({
      update_id: 1,
      id: 'cbq',
      chatId: 42,
      messageId: 1002,
      senderId: 666, // not paired
      data: 'perm:r-unpaired:allow',
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(verdicts).toHaveLength(0);
  });

  it('pairing mode: callback_query from paired sender is accepted (no allowlist check)', async () => {
    // Sanity check: pairing mode (default in beforeEach) must not gate on the
    // (empty) allowlist. Sender 99 was pre-bound in beforeEach.
    await adapter.sendPermissionPrompt({
      requestId: 'r-pairing',
      sessionId: 'booknerds',
      toolName: 'Bash',
      description: 'x',
      inputPreview: '{}',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const verdicts: unknown[] = [];
    const orig = router.ingestPermissionVerdict.bind(router);
    router.ingestPermissionVerdict = async (v) => {
      verdicts.push(v);
      return orig(v);
    };
    fake.enqueueCallbackQuery({
      update_id: 1,
      id: 'cbq-pairing',
      chatId: 42,
      messageId: 1003,
      senderId: 99,
      data: 'perm:r-pairing:allow',
    });
    await waitFor(() => verdicts.length > 0, 2000);
    expect(verdicts).toHaveLength(1);
  });

  it('cancelPermissionPrompt edits the message and clears storage', async () => {
    await adapter.sendPermissionPrompt({
      requestId: 'rx',
      sessionId: 'booknerds',
      toolName: 'Bash',
      description: 'x',
      inputPreview: '{}',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await adapter.cancelPermissionPrompt('rx', 'terminal');
    expect(fake.edits.length).toBeGreaterThanOrEqual(1);
    expect(fake.edits[0]!.text).toContain('Answered in Claude Code terminal');
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
