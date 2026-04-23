import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase, type DatabaseHandle } from '@rederjs/core/storage/db';
import { createSession } from '@rederjs/core/sessions';
import { createLogger } from '@rederjs/core/logger';
import { createIpcServer, type IpcServer } from '@rederjs/core/ipc/server';

const HERE = dirname(fileURLToPath(import.meta.url));

let dir: string;
let db: DatabaseHandle;
let ipcServer: IpcServer;
let socketPath: string;
let token: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-hook-cli-'));
  db = openDatabase(join(dir, 'test.db'));
  socketPath = join(dir, 'reder.sock');
  const logger = createLogger({ level: 'error', destination: { write: () => {} } });
  ipcServer = await createIpcServer({ db: db.raw, socketPath, logger });
  const { token: t } = await createSession(db.raw, 'sess', 'Sess');
  token = t;
});

afterEach(async () => {
  await ipcServer.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function runHook(args: string[], stdin: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const entry = join(HERE, '..', 'dist', 'hook-cli.js');
    const child = spawn(process.execPath, [entry, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stderr }));
    child.stdin.end(stdin);
  });
}

describe('reder-hook', () => {
  it('delivers a hook_event and exits 0', async () => {
    const received: Array<{ hook: string }> = [];
    ipcServer.on('hook_event', (evt) => received.push({ hook: evt.hook }));

    const { code } = await runHook(
      [
        '--session-id', 'sess',
        '--socket', socketPath,
        '--token', token,
        '--hook', 'UserPromptSubmit',
      ],
      JSON.stringify({ cwd: '/tmp', transcript_path: '/tmp/t.jsonl' }),
    );
    expect(code).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toEqual([{ hook: 'UserPromptSubmit' }]);
  });

  it('exits 0 when the socket is missing', async () => {
    await ipcServer.close();
    const { code } = await runHook(
      [
        '--session-id', 'sess',
        '--socket', join(dir, 'nope.sock'),
        '--token', token,
        '--hook', 'Stop',
      ],
      '{}',
    );
    expect(code).toBe(0);
  });

  it('exits non-zero when required args are missing', async () => {
    const { code } = await runHook(['--hook', 'Stop'], '{}');
    expect(code).not.toBe(0);
  });
});
