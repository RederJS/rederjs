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
import {
  runSessionRepair,
  runSessionRepairAll,
  interactiveSessionRepair,
} from '../src/commands/sessions-repair.js';

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

describe('runSessionRepairAll', () => {
  it('repairs every registered session and rotates each token', async () => {
    const projA = join(dir, 'a');
    const projB = join(dir, 'b');
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    const a = await runSessionAdd({
      sessionId: 'sess_a',
      displayName: 'A',
      projectDir: projA,
      configPath,
      shimCommand: ['reder-shim'],
    });
    const b = await runSessionAdd({
      sessionId: 'sess_b',
      displayName: 'B',
      projectDir: projB,
      configPath,
      shimCommand: ['reder-shim'],
    });
    const tokenA = readFileSync(a.tokenFilePath, 'utf8').trim();
    const tokenB = readFileSync(b.tokenFilePath, 'utf8').trim();

    const res = await runSessionRepairAll({ configPath });
    expect(res.results).toHaveLength(2);
    expect(res.results.every((r) => r.ok)).toBe(true);
    const ids = res.results.map((r) => r.sessionId).sort();
    expect(ids).toEqual(['sess_a', 'sess_b']);
    expect(readFileSync(a.tokenFilePath, 'utf8').trim()).not.toBe(tokenA);
    expect(readFileSync(b.tokenFilePath, 'utf8').trim()).not.toBe(tokenB);
  });

  it('skips sessions without workspace_dir, reports them, and continues', async () => {
    const projA = join(dir, 'a');
    mkdirSync(projA, { recursive: true });
    await runSessionAdd({
      sessionId: 'sess_a',
      displayName: 'A',
      projectDir: projA,
      configPath,
      shimCommand: ['reder-shim'],
    });
    // Insert a workspace-less session into the YAML by rewriting the sessions
    // block. The naive `cur + '  - session_id: ...'` appends after `adapters:`
    // and produces invalid YAML.
    writeFileSync(
      configPath,
      `version: 1\nruntime:\n  runtime_dir: ${dir}/runtime\n  data_dir: ${dir}/data\n` +
        `sessions:\n` +
        `  - session_id: sess_a\n` +
        `    display_name: A\n` +
        `    workspace_dir: ${projA}\n` +
        `    auto_start: false\n` +
        `    permission_mode: default\n` +
        `  - session_id: ad_hoc\n` +
        `    display_name: Adhoc\n` +
        `    auto_start: false\n` +
        `    permission_mode: default\n` +
        `adapters: {}\n`,
    );

    const res = await runSessionRepairAll({ configPath });
    expect(res.results).toHaveLength(2);
    const adhoc = res.results.find((r) => r.sessionId === 'ad_hoc');
    expect(adhoc).toBeDefined();
    expect(adhoc!.ok).toBe(false);
    if (!adhoc!.ok) expect(adhoc!.reason).toBe('no_workspace_dir');
    const sa = res.results.find((r) => r.sessionId === 'sess_a');
    expect(sa!.ok).toBe(true);
  });

  it('returns empty results when no sessions are configured', async () => {
    const res = await runSessionRepairAll({ configPath });
    expect(res.results).toEqual([]);
  });
});

describe('interactiveSessionRepair', () => {
  it('dispatches single-session repair when sessionIdArg is provided', async () => {
    const proj = join(dir, 'proj');
    mkdirSync(proj, { recursive: true });
    await runSessionAdd({
      sessionId: 'sess',
      displayName: 'Sess',
      projectDir: proj,
      configPath,
      shimCommand: ['reder-shim'],
    });
    const r = await interactiveSessionRepair({
      sessionIdArg: 'sess',
      configPath,
      nonInteractive: true,
    });
    expect(r.kind).toBe('single');
    if (r.kind === 'single') expect(r.result.sessionId).toBe('sess');
  });

  it('dispatches bulk repair when all=true', async () => {
    const proj = join(dir, 'proj');
    mkdirSync(proj, { recursive: true });
    await runSessionAdd({
      sessionId: 'sess',
      displayName: 'Sess',
      projectDir: proj,
      configPath,
      shimCommand: ['reder-shim'],
    });
    const r = await interactiveSessionRepair({
      all: true,
      configPath,
      nonInteractive: true,
    });
    expect(r.kind).toBe('all');
    if (r.kind === 'all') expect(r.result.results).toHaveLength(1);
  });

  it('throws in non-interactive mode when neither sessionIdArg nor all is provided', async () => {
    const proj = join(dir, 'proj');
    mkdirSync(proj, { recursive: true });
    await runSessionAdd({
      sessionId: 'sess',
      displayName: 'Sess',
      projectDir: proj,
      configPath,
      shimCommand: ['reder-shim'],
    });
    await expect(interactiveSessionRepair({ configPath, nonInteractive: true })).rejects.toThrow(
      /<session-id>|--all/,
    );
  });

  it('throws when no sessions are configured', async () => {
    await expect(
      interactiveSessionRepair({ all: true, configPath, nonInteractive: true }),
    ).resolves.toMatchObject({ kind: 'all', result: { results: [] } });
    await expect(interactiveSessionRepair({ configPath, nonInteractive: true })).rejects.toThrow(
      /No sessions configured/,
    );
  });
});
