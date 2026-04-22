import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runSessionAdd,
  ConfigNotFoundError,
  SessionWorkspaceMismatchError,
  InvalidSessionIdError,
} from '../src/commands/sessions-add.js';
import { scaffoldConfig, peekSession } from '../src/commands/config-writer.js';
import * as service from '../src/commands/service.js';

let dir: string;
let configPath: string;
let envPath: string;
let projectDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-cli-sessions-add-test-'));
  configPath = join(dir, 'reder.config.yaml');
  envPath = join(dir, 'reder.env');
  projectDir = join(dir, 'project');
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function seedConfig(): void {
  writeFileSync(
    configPath,
    `version: 1
runtime:
  runtime_dir: ${join(dir, 'runtime')}
  data_dir: ${join(dir, 'data')}
sessions: []
adapters:
  web:
    module: '@rederjs/adapter-web'
    enabled: true
    config:
      bind: 127.0.0.1
      port: 7781
`,
    { mode: 0o600 },
  );
  writeFileSync(envPath, '', { mode: 0o600 });
}

describe('runSessionAdd', () => {
  it('fails with ConfigNotFoundError when config missing', async () => {
    await expect(
      runSessionAdd({ sessionId: 'xx', projectDir, configPath }),
    ).rejects.toBeInstanceOf(ConfigNotFoundError);
  });

  it('adds session entry to YAML with workspace_dir and auto_start', async () => {
    seedConfig();
    const r = await runSessionAdd({
      sessionId: 'mysession',
      displayName: 'My Session',
      projectDir,
      configPath,
      autoStart: false,
    });
    expect(r.yamlCreated).toBe(true);
    expect(r.workspaceDir).toBe(projectDir);
    const p = peekSession({ configPath, sessionId: 'mysession' });
    expect(p).toEqual({
      session_id: 'mysession',
      display_name: 'My Session',
      workspace_dir: projectDir,
      auto_start: false,
    });
  });

  it('creates .mcp.json with token and mode 0600', async () => {
    seedConfig();
    const r = await runSessionAdd({ sessionId: 'booknerds', projectDir, configPath });
    expect(statSync(r.mcpJsonPath).mode & 0o777).toBe(0o600);
    const doc = JSON.parse(readFileSync(r.mcpJsonPath, 'utf8')) as {
      mcpServers: { reder: { command: string; args: string[] } };
    };
    expect(doc.mcpServers.reder.command).toBe('reder-shim');
    const args = doc.mcpServers.reder.args;
    expect(args[args.indexOf('--session-id') + 1]).toBe('booknerds');
    const token = args[args.indexOf('--token') + 1]!;
    expect(token).toMatch(/^rdr_sess_/);
    expect(r.tokenRotated).toBe(false);
  });

  it('rotates token on re-install', async () => {
    seedConfig();
    const first = await runSessionAdd({ sessionId: 'ss', projectDir, configPath });
    const firstDoc = JSON.parse(readFileSync(first.mcpJsonPath, 'utf8')) as {
      mcpServers: { reder: { args: string[] } };
    };
    const firstToken =
      firstDoc.mcpServers.reder.args[firstDoc.mcpServers.reder.args.indexOf('--token') + 1];
    const second = await runSessionAdd({ sessionId: 'ss', projectDir, configPath });
    const secondDoc = JSON.parse(readFileSync(second.mcpJsonPath, 'utf8')) as {
      mcpServers: { reder: { args: string[] } };
    };
    const secondToken =
      secondDoc.mcpServers.reder.args[secondDoc.mcpServers.reder.args.indexOf('--token') + 1];
    expect(secondToken).not.toBe(firstToken);
    expect(second.tokenRotated).toBe(true);
  });

  it('preserves other mcpServers entries', async () => {
    seedConfig();
    writeFileSync(
      join(projectDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { otherTool: { command: 'foo', args: ['--bar'] } },
      }),
    );
    const r = await runSessionAdd({ sessionId: 'xx', projectDir, configPath });
    const doc = JSON.parse(readFileSync(r.mcpJsonPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(doc.mcpServers['otherTool']).toBeTruthy();
    expect(doc.mcpServers['reder']).toBeTruthy();
  });

  it('throws SessionWorkspaceMismatchError on collision without forceRebind', async () => {
    seedConfig();
    const otherDir = join(dir, 'other');
    mkdirSync(otherDir, { recursive: true });
    await runSessionAdd({ sessionId: 'shared', projectDir, configPath });
    await expect(
      runSessionAdd({ sessionId: 'shared', projectDir: otherDir, configPath }),
    ).rejects.toBeInstanceOf(SessionWorkspaceMismatchError);
  });

  it('rebinds on collision with forceRebind', async () => {
    seedConfig();
    const otherDir = join(dir, 'other');
    mkdirSync(otherDir, { recursive: true });
    await runSessionAdd({ sessionId: 'shared', projectDir, configPath });
    const r = await runSessionAdd({
      sessionId: 'shared',
      projectDir: otherDir,
      configPath,
      forceRebind: true,
    });
    expect(r.workspaceDir).toBe(otherDir);
    const p = peekSession({ configPath, sessionId: 'shared' });
    expect(p?.workspace_dir).toBe(otherDir);
  });

  it('rejects invalid session ids', async () => {
    seedConfig();
    await expect(
      runSessionAdd({ sessionId: 'Invalid-ID', projectDir, configPath }),
    ).rejects.toBeInstanceOf(InvalidSessionIdError);
  });

  it('invokes runStart when autoStart is true', async () => {
    seedConfig();
    const spy = vi
      .spyOn(service, 'runStart')
      .mockReturnValue({ method: 'direct', ok: true, detail: 'forked (pid 1)' });
    const r = await runSessionAdd({
      sessionId: 'runner',
      projectDir,
      configPath,
      autoStart: true,
    });
    expect(spy).toHaveBeenCalledOnce();
    expect(r.daemonStart).toEqual({ method: 'direct', ok: true, detail: 'forked (pid 1)' });
    const p = peekSession({ configPath, sessionId: 'runner' });
    expect(p?.auto_start).toBe(true);
  });

  it('does not call runStart when autoStart is false', async () => {
    seedConfig();
    const spy = vi.spyOn(service, 'runStart');
    await runSessionAdd({ sessionId: 'quiet', projectDir, configPath, autoStart: false });
    expect(spy).not.toHaveBeenCalled();
  });
});
