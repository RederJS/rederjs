import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall } from '../src/commands/install.js';

let dir: string;
let configPath: string;
let projectDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-cli-install-test-'));
  projectDir = join(dir, 'project');
  require('node:fs').mkdirSync(projectDir, { recursive: true });
  configPath = join(dir, 'reder.config.yaml');
  writeFileSync(
    configPath,
    `version: 1
runtime:
  runtime_dir: ${join(dir, 'runtime')}
  data_dir: ${join(dir, 'data')}
sessions: []
adapters: {}
`,
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runInstall', () => {
  it('creates session, generates token, writes .mcp.json with mode 0600', async () => {
    const result = await runInstall({ sessionId: 'booknerds', projectDir, configPath });
    expect(existsSync(result.mcpJsonPath)).toBe(true);
    expect(statSync(result.mcpJsonPath).mode & 0o777).toBe(0o600);
    const doc = JSON.parse(readFileSync(result.mcpJsonPath, 'utf8')) as {
      mcpServers: { reder: { command: string; args: string[] } };
    };
    expect(doc.mcpServers.reder.command).toBe('reder-shim');
    const args = doc.mcpServers.reder.args;
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe('booknerds');
    expect(args).toContain('--token');
    const token = args[args.indexOf('--token') + 1]!;
    expect(token).toMatch(/^rdr_sess_/);
    expect(result.tokenRotated).toBe(false);
  });

  it('rotates the token on re-install', async () => {
    const first = await runInstall({ sessionId: 's', projectDir, configPath });
    const firstDoc = JSON.parse(readFileSync(first.mcpJsonPath, 'utf8')) as {
      mcpServers: { reder: { args: string[] } };
    };
    const firstToken =
      firstDoc.mcpServers.reder.args[firstDoc.mcpServers.reder.args.indexOf('--token') + 1];
    const second = await runInstall({ sessionId: 's', projectDir, configPath });
    const secondDoc = JSON.parse(readFileSync(second.mcpJsonPath, 'utf8')) as {
      mcpServers: { reder: { args: string[] } };
    };
    const secondToken =
      secondDoc.mcpServers.reder.args[secondDoc.mcpServers.reder.args.indexOf('--token') + 1];
    expect(secondToken).not.toBe(firstToken);
    expect(second.tokenRotated).toBe(true);
  });

  it('preserves other mcpServers entries', async () => {
    writeFileSync(
      join(projectDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { otherTool: { command: 'foo', args: ['--bar'] } },
      }),
    );
    const result = await runInstall({ sessionId: 'x', projectDir, configPath });
    const doc = JSON.parse(readFileSync(result.mcpJsonPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(doc.mcpServers['otherTool']).toBeTruthy();
    expect(doc.mcpServers['reder']).toBeTruthy();
  });
});
