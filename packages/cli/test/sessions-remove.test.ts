import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSessionAdd } from '../src/commands/sessions-add.js';
import { runSessionRemove, SessionNotFoundError } from '../src/commands/sessions-remove.js';
import { peekSession, scaffoldConfig } from '../src/commands/config-writer.js';

let dir: string;
let configPath: string;
let envPath: string;
let projectDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-cli-sessions-remove-test-'));
  configPath = join(dir, 'reder.config.yaml');
  envPath = join(dir, 'reder.env');
  projectDir = join(dir, 'project');
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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

describe('runSessionRemove', () => {
  it('throws SessionNotFoundError when session absent', () => {
    seedConfig();
    expect(() => runSessionRemove({ sessionId: 'ghost', configPath })).toThrow(
      SessionNotFoundError,
    );
  });

  it('removes YAML entry, DB row, and mcp reder entry (preserving other mcpServers)', async () => {
    seedConfig();
    await runSessionAdd({ sessionId: 'gone', projectDir, configPath });
    writeFileSync(
      join(projectDir, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            reder: JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8')).mcpServers.reder,
            otherTool: { command: 'foo', args: ['--bar'] },
          },
        },
        null,
        2,
      ),
    );

    const r = runSessionRemove({ sessionId: 'gone', configPath });
    expect(r.yamlRemoved).toBe(true);
    expect(r.dbRemoved).toBe(true);
    expect(r.mcpEntryRemoved).toBe(true);
    expect(peekSession({ configPath, sessionId: 'gone' })).toBeUndefined();

    const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcp.mcpServers['reder']).toBeUndefined();
    expect(mcp.mcpServers['otherTool']).toBeTruthy();
  });

  it('skips mcp update when workspace_dir missing from YAML', () => {
    scaffoldConfig({ configPath, envPath, webBind: '127.0.0.1', webPort: 7781 });
    writeFileSync(
      configPath,
      readFileSync(configPath, 'utf8').replace(
        'sessions: []',
        `sessions:\n  - session_id: legacy\n    display_name: Legacy\n    auto_start: false\n`,
      ),
    );
    const r = runSessionRemove({ sessionId: 'legacy', configPath });
    expect(r.yamlRemoved).toBe(true);
    expect(r.mcpEntryRemoved).toBe(false);
    expect(r.mcpJsonPath).toBeUndefined();
  });

  it('emits a warning when workspace_dir no longer exists', async () => {
    seedConfig();
    await runSessionAdd({ sessionId: 'ghosttown', projectDir, configPath });
    rmSync(projectDir, { recursive: true, force: true });
    const r = runSessionRemove({ sessionId: 'ghosttown', configPath });
    expect(r.yamlRemoved).toBe(true);
    expect(r.dbRemoved).toBe(true);
    expect(r.mcpEntryRemoved).toBe(false);
    expect(r.warnings.some((w) => w.includes('does not exist'))).toBe(true);
  });

  it('respects keepMcp=true', async () => {
    seedConfig();
    await runSessionAdd({ sessionId: 'keepers', projectDir, configPath });
    const before = readFileSync(join(projectDir, '.mcp.json'), 'utf8');
    const r = runSessionRemove({ sessionId: 'keepers', configPath, keepMcp: true });
    expect(r.yamlRemoved).toBe(true);
    expect(r.mcpEntryRemoved).toBe(false);
    expect(readFileSync(join(projectDir, '.mcp.json'), 'utf8')).toBe(before);
  });

  it('removes Claude hooks from .claude/settings.local.json', async () => {
    seedConfig();
    await runSessionAdd({ sessionId: 'sess', projectDir, configPath });
    expect(existsSync(join(projectDir, '.claude', 'settings.local.json'))).toBe(true);

    runSessionRemove({ sessionId: 'sess', configPath });
    expect(existsSync(join(projectDir, '.claude', 'settings.local.json'))).toBe(false);
  });
});
