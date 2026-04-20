import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bootstrap, type BootstrapResult } from '../../src/bootstrap.js';
import { insertOutbound } from '../../../core/src/storage/outbox.js';
import { FakeAdapter } from '../../../core/test/fixtures/fake-adapter.js';

let dir: string;
let configPath: string;
let port = 18900;
let daemon: BootstrapResult | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-chaos-cold-'));
  configPath = join(dir, 'reder.config.yaml');
  port++;
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
  - session_id: ss
    display_name: S
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

describe('NFR-R3: daemon cold restart', () => {
  it('recovers in <30s with 1000 pending outbound entries', async () => {
    // Bootstrap once to create DB, then shut down.
    const first = await bootstrap({
      configPath,
      overrideResolveModule: async () => async () => new FakeAdapter('fake'),
    });
    // Insert 1000 pending outbound rows.
    for (let i = 0; i < 1000; i++) {
      insertOutbound(first.db.raw, {
        message_id: randomUUID(),
        session_id: 'ss',
        adapter: 'fake',
        recipient: 'r',
        content: `m${i}`,
        meta: {},
        files: [],
      });
    }
    await first.stop();

    const t0 = Date.now();
    daemon = await bootstrap({
      configPath,
      overrideResolveModule: async () => async () => new FakeAdapter('fake'),
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(30_000);

    // Health endpoint reports the outbox depth immediately.
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = (await res.json()) as { outbox: { outbound_pending: number } };
    expect(body.outbox.outbound_pending).toBe(1000);
  });
});
