import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap, type BootstrapResult } from '../../daemon/src/bootstrap.js';
import { FakeAdapter } from '../../core/test/fixtures/fake-adapter.js';
import { runDoctor } from '../src/commands/doctor.js';
import { runStatus } from '../src/commands/status.js';
import { runSessionAdd } from '../src/commands/sessions-add.js';
import { runSessionRemove } from '../src/commands/sessions-remove.js';
import { ConfigNotFoundError } from '../src/commands/sessions-add.js';
import { runPair } from '../src/commands/pair.js';
import { existsSync, readFileSync } from 'node:fs';
import { createPairCode } from '../../core/src/pairing.js';
import { isPaired } from '../../core/src/pairing.js';

let dir: string;
let configPath: string;
let projectDir: string;
let daemon: BootstrapResult | null = null;
let port = 18500;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-cli-int-test-'));
  projectDir = join(dir, 'project');
  require('node:fs').mkdirSync(projectDir, { recursive: true });
  port++;
  configPath = join(dir, 'reder.config.yaml');
  writeFileSync(
    configPath,
    `version: 1
runtime:
  runtime_dir: ${join(dir, 'runtime')}
  data_dir: ${join(dir, 'data')}
health:
  enabled: true
  port: ${port}
sessions:
  - session_id: booknerds
    display_name: BookNerds
adapters:
  fake:
    module: fake-stub
    config: {}
`,
  );
});

afterEach(async () => {
  if (daemon) await daemon.stop();
  daemon = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('cli integration', () => {
  it('runStatus fetches health from a live daemon', async () => {
    daemon = await bootstrap({
      configPath,
      overrideResolveModule: async () => async () => new FakeAdapter('fake'),
    });
    const result = await runStatus({ configPath });
    expect(result.reachable).toBe(true);
    expect(result.health).toBeTruthy();
  });

  it('runDoctor reports config parse + daemon reachable + adapter provenance', async () => {
    daemon = await bootstrap({
      configPath,
      overrideResolveModule: async () => async () => new FakeAdapter('fake'),
    });
    const checks = await runDoctor({ configPath });
    const names = checks.map((c) => c.name);
    expect(names).toContain('Node >= 20');
    expect(names).toContain('config parses');
    expect(names).toContain('daemon reachable');
    expect(names).toContain('adapter fake provenance');
    const daemonCheck = checks.find((c) => c.name === 'daemon reachable');
    expect(daemonCheck?.pass).toBe(true);
  });

  it('runDoctor flags daemon unreachable when no daemon is running', async () => {
    const checks = await runDoctor({ configPath });
    const daemonCheck = checks.find((c) => c.name === 'daemon reachable');
    expect(daemonCheck?.pass).toBe(false);
  });

  it('runSessionAdd + runPair end-to-end: CLI pairs a sender via admin IPC', async () => {
    daemon = await bootstrap({
      configPath,
      overrideResolveModule: async () => async () => new FakeAdapter('fake'),
    });
    const inst = await runSessionAdd({
      sessionId: 'booknerds',
      projectDir,
      configPath,
      shimCommand: ['reder-shim'],
    });
    expect(inst.sessionId).toBe('booknerds');

    const rec = createPairCode(daemon.db.raw, {
      adapter: 'fake-adapter',
      senderId: 'user-1',
      senderMetadata: { chat_id: '42' },
    });

    const result = await runPair({ code: rec.code, projectDir });
    expect(result.success).toBe(true);
    expect(result.adapter).toBe('fake-adapter');
    expect(result.senderId).toBe('user-1');
    expect(isPaired(daemon.db.raw, 'fake-adapter', 'user-1', 'booknerds')).toBe(true);
  });

  it('runSessionAdd fails with ConfigNotFoundError when config missing', async () => {
    const missingConfig = join(dir, 'does-not-exist.yaml');
    await expect(
      runSessionAdd({ sessionId: 'booknerds', projectDir, configPath: missingConfig }),
    ).rejects.toBeInstanceOf(ConfigNotFoundError);
  });

  it('runSessionAdd then runSessionRemove cleans up YAML + DB + .mcp.json', async () => {
    daemon = await bootstrap({
      configPath,
      overrideResolveModule: async () => async () => new FakeAdapter('fake'),
    });
    const inst = await runSessionAdd({
      sessionId: 'booknerds',
      projectDir,
      configPath,
    });
    expect(existsSync(inst.mcpJsonPath)).toBe(true);

    const r = runSessionRemove({ sessionId: 'booknerds', configPath });
    expect(r.yamlRemoved).toBe(true);
    expect(r.dbRemoved).toBe(true);
    expect(r.mcpEntryRemoved).toBe(true);

    const mcp = JSON.parse(readFileSync(inst.mcpJsonPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcp.mcpServers['reder']).toBeUndefined();
  });
});
