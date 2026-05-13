import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSessionAdd } from '../src/commands/sessions-add.js';
import { runSessionRepair } from '../src/commands/sessions-repair.js';

let dir: string;
let projectDir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-repair-'));
  projectDir = join(dir, 'proj');
  configPath = join(dir, 'reder.config.yaml');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    configPath,
    `version: 1\nruntime:\n  runtime_dir: ${dir}/runtime\n  data_dir: ${dir}/data\nsessions: []\nadapters: {}\n`,
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runSessionRepair', () => {
  it('recreates missing .claude/settings.local.json', async () => {
    await runSessionAdd({
      sessionId: 'sess',
      displayName: 'Sess',
      projectDir,
      configPath,
      shimCommand: ['reder-shim'],
    });
    const hooksPath = join(projectDir, '.claude', 'settings.local.json');
    unlinkSync(hooksPath);
    expect(existsSync(hooksPath)).toBe(false);

    await runSessionRepair({ sessionId: 'sess', configPath });
    expect(existsSync(hooksPath)).toBe(true);
  });

  it('recreates missing .mcp.json', async () => {
    await runSessionAdd({
      sessionId: 'sess',
      displayName: 'Sess',
      projectDir,
      configPath,
      shimCommand: ['reder-shim'],
    });
    unlinkSync(join(projectDir, '.mcp.json'));
    await runSessionRepair({ sessionId: 'sess', configPath });
    expect(existsSync(join(projectDir, '.mcp.json'))).toBe(true);
  });

  it('refreshes the token when the session token has drifted', async () => {
    const added = await runSessionAdd({
      sessionId: 'sess',
      displayName: 'Sess',
      projectDir,
      configPath,
      shimCommand: ['reder-shim'],
    });
    const tokenBefore = readFileSync(added.tokenFilePath, 'utf8').trim();
    const res = await runSessionRepair({ sessionId: 'sess', configPath });
    expect(res.tokenRotated).toBe(true);
    const tokenAfter = readFileSync(res.tokenFilePath, 'utf8').trim();
    expect(tokenAfter).not.toBe(tokenBefore);
  });

  it('migrates legacy .mcp.json that used --token to --token-file', async () => {
    const added = await runSessionAdd({
      sessionId: 'sess',
      displayName: 'Sess',
      projectDir,
      configPath,
      shimCommand: ['reder-shim'],
    });
    // Simulate a legacy .mcp.json from before this fix (token on argv).
    const mcpPath = join(projectDir, '.mcp.json');
    const doc = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
      mcpServers: { reder: { command: string; args: string[] } };
    };
    doc.mcpServers.reder.args = [
      '--session-id',
      'sess',
      '--token',
      'rdr_sess_legacy_inline_secret',
      '--socket',
      '/tmp/reder.sock',
    ];
    writeFileSync(mcpPath, JSON.stringify(doc, null, 2) + '\n');

    await runSessionRepair({ sessionId: 'sess', configPath });
    const after = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
      mcpServers: { reder: { args: string[] } };
    };
    expect(after.mcpServers.reder.args).not.toContain('--token');
    expect(after.mcpServers.reder.args).toContain('--token-file');
    expect(JSON.stringify(after)).not.toContain('rdr_sess_legacy_inline_secret');
    // The token file is the same per-session path.
    expect(
      after.mcpServers.reder.args[after.mcpServers.reder.args.indexOf('--token-file') + 1],
    ).toBe(added.tokenFilePath);
  });

  it('throws when the session is not registered', async () => {
    await expect(runSessionRepair({ sessionId: 'nope', configPath })).rejects.toThrow(/not found/i);
  });

  it('throws when the session has no workspace_dir', async () => {
    writeFileSync(
      configPath,
      `version: 1\nruntime:\n  runtime_dir: ${dir}/runtime\n  data_dir: ${dir}/data\n` +
        `sessions:\n  - session_id: ad_hoc\n    display_name: Adhoc\n    auto_start: false\nadapters: {}\n`,
    );
    await expect(runSessionRepair({ sessionId: 'ad_hoc', configPath })).rejects.toThrow(
      /workspace_dir/i,
    );
  });
});
