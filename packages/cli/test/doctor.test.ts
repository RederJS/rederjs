import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../src/commands/doctor.js';
import { runSessionAdd } from '../src/commands/sessions-add.js';

let dir: string;
let projectDir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-doctor-'));
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

describe('doctor hook checks', () => {
  it('passes for sessions with hooks installed', async () => {
    await runSessionAdd({
      sessionId: 'sess',
      displayName: 'Sess',
      projectDir,
      configPath,
      shimCommand: ['reder-shim'],
    });
    const checks = await runDoctor({ configPath });
    const hookCheck = checks.find((c) => c.name === "claude hooks for 'sess'");
    expect(hookCheck?.pass).toBe(true);
  });

  it('fails and offers remediation for sessions without hooks', async () => {
    const yaml =
      `version: 1\nruntime:\n  runtime_dir: ${dir}/runtime\n  data_dir: ${dir}/data\n` +
      `sessions:\n  - session_id: barebones\n    display_name: Barebones\n    workspace_dir: ${projectDir}\n    auto_start: false\nadapters: {}\n`;
    writeFileSync(configPath, yaml);
    const checks = await runDoctor({ configPath });
    const hookCheck = checks.find((c) => c.name === "claude hooks for 'barebones'");
    expect(hookCheck?.pass).toBe(false);
    expect(hookCheck?.remediation).toContain('sessions repair barebones');
  });

  it('does not emit a check for sessions without a workspace_dir', async () => {
    const yaml =
      `version: 1\nruntime:\n  runtime_dir: ${dir}/runtime\n  data_dir: ${dir}/data\n` +
      `sessions:\n  - session_id: adhoc\n    display_name: Adhoc\n    auto_start: false\nadapters: {}\n`;
    writeFileSync(configPath, yaml);
    const checks = await runDoctor({ configPath });
    const hookCheck = checks.find((c) => c.name === "claude hooks for 'adhoc'");
    expect(hookCheck).toBeUndefined();
  });
});
