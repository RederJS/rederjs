import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap, type BootstrapResult } from '../src/bootstrap.js';
import { FakeAdapter } from '../../core/test/fixtures/fake-adapter.js';

let dir: string;
let result: BootstrapResult | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-bootstrap-test-'));
});

afterEach(async () => {
  if (result) await result.stop();
  result = null;
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(portOffset: number): string {
  const path = join(dir, 'reder.config.yaml');
  const port = 17780 + portOffset;
  writeFileSync(
    path,
    `version: 1
runtime:
  runtime_dir: ${join(dir, 'runtime')}
  data_dir: ${join(dir, 'data')}
health:
  enabled: true
  bind: 127.0.0.1
  port: ${port}
sessions:
  - session_id: testsess
    display_name: Test
adapters:
  fake:
    module: fake-stub
    config:
      hello: world
`,
  );
  return path;
}

describe('bootstrap', () => {
  it('starts daemon with adapters resolved by injected resolver', async () => {
    const configPath = writeConfig(1);
    const fake = new FakeAdapter('fake');
    result = await bootstrap({
      configPath,
      overrideResolveModule: async () => async () => fake,
    });
    expect(result.adapterHost.loaded.map((l) => l.name)).toContain('fake');
    expect(result.health).toBeTruthy();
  });

  it('health endpoint returns a snapshot including sessions', async () => {
    const configPath = writeConfig(2);
    const fake = new FakeAdapter('fake');
    result = await bootstrap({
      configPath,
      overrideResolveModule: async () => async () => fake,
    });
    const port = result.health?.port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      daemon: { version: string };
      sessions: Array<{ session_id: string }>;
    };
    expect(body.daemon.version).toBe('0.1.0');
    expect(body.sessions.map((s) => s.session_id)).toContain('testsess');
  });

  it('auto-registers sessions declared in config', async () => {
    const configPath = writeConfig(3);
    const fake = new FakeAdapter('fake');
    result = await bootstrap({
      configPath,
      overrideResolveModule: async () => async () => fake,
    });
    const row = result.db.raw
      .prepare('SELECT session_id, state FROM sessions WHERE session_id = ?')
      .get('testsess');
    expect(row).toMatchObject({ session_id: 'testsess', state: 'registered' });
  });

  it('skips disabled adapters', async () => {
    const configPath = join(dir, 'c4.yaml');
    writeFileSync(
      configPath,
      `version: 1
runtime:
  runtime_dir: ${join(dir, 'runtime')}
  data_dir: ${join(dir, 'data')}
health:
  enabled: true
  port: 17784
adapters:
  fake:
    module: fake-stub
    enabled: false
    config: {}
`,
    );
    let resolverCalls = 0;
    const fake = new FakeAdapter('fake');
    result = await bootstrap({
      configPath,
      overrideResolveModule: async () => {
        resolverCalls++;
        return async () => fake;
      },
    });
    expect(resolverCalls).toBe(0);
    expect(result.adapterHost.loaded).toHaveLength(0);
  });
});
