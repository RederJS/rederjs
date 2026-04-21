import { existsSync } from 'node:fs';
import { loadConfigContext } from '../config-loader.js';
import { fetchHealth } from '../admin-client.js';
import { ConfigError } from '@rederjs/core/config';

export interface DoctorCheck {
  name: string;
  pass: boolean;
  detail: string;
  remediation?: string;
}

export async function runDoctor(opts: { configPath?: string } = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node >= 20',
    pass: major >= 20,
    detail: `running Node ${process.versions.node}`,
    ...(major < 20 ? { remediation: 'Upgrade Node to 20 or newer.' } : {}),
  });

  let ctx;
  try {
    ctx = loadConfigContext(opts.configPath);
    checks.push({ name: 'config parses', pass: true, detail: ctx.configPath });
  } catch (err) {
    checks.push({
      name: 'config parses',
      pass: false,
      detail: (err as Error).message,
      remediation: err instanceof ConfigError ? 'Edit the config and re-run.' : 'See `reder init`.',
    });
    return checks;
  }

  checks.push({
    name: 'runtime_dir exists',
    pass: existsSync(ctx.runtimeDir),
    detail: ctx.runtimeDir,
    ...(!existsSync(ctx.runtimeDir)
      ? { remediation: `mkdir -p ${ctx.runtimeDir}` }
      : {}),
  });
  checks.push({
    name: 'data_dir exists',
    pass: existsSync(ctx.dataDir),
    detail: ctx.dataDir,
    ...(!existsSync(ctx.dataDir) ? { remediation: `mkdir -p ${ctx.dataDir}` } : {}),
  });

  // Check env vars referenced in adapter configs
  const envRefs: string[] = [];
  for (const [, adapter] of Object.entries(ctx.config.adapters)) {
    walkForEnvRefs(adapter.config, envRefs);
  }
  for (const varName of envRefs) {
    checks.push({
      name: `env ${varName}`,
      pass: !!process.env[varName],
      detail: process.env[varName] ? 'present' : 'missing',
      ...(!process.env[varName]
        ? { remediation: `Set ${varName} in reder.env and restart the daemon.` }
        : {}),
    });
  }

  // Flag third-party adapters
  for (const [name, cfg] of Object.entries(ctx.config.adapters)) {
    if (!cfg.enabled) continue;
    checks.push({
      name: `adapter ${name} provenance`,
      pass: cfg.module.startsWith('@rederjs/'),
      detail: cfg.module,
      ...(cfg.module.startsWith('@rederjs/')
        ? {}
        : {
            remediation:
              'Third-party adapter. Audit the source before trusting it with your session.',
          }),
    });
  }

  if (ctx.config.health.enabled) {
    const url = `http://${ctx.config.health.bind}:${ctx.config.health.port}/health`;
    try {
      await fetchHealth(url, 1500);
      checks.push({ name: 'daemon reachable', pass: true, detail: url });
    } catch (err) {
      checks.push({
        name: 'daemon reachable',
        pass: false,
        detail: (err as Error).message,
        remediation: 'Start rederd with `reder start` or `systemctl --user start reder`.',
      });
    }
  }

  return checks;
}

function walkForEnvRefs(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    const matches = node.matchAll(/\$\{env:([^}]+)\}/g);
    for (const m of matches) {
      if (m[1]) out.push(m[1]);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) walkForEnvRefs(v, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) walkForEnvRefs(v, out);
  }
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks
    .map((c) => {
      const mark = c.pass ? '✓' : '✗';
      const base = `${mark} ${c.name}: ${c.detail}`;
      return c.pass ? base : `${base}\n    → ${c.remediation ?? 'n/a'}`;
    })
    .join('\n');
}
