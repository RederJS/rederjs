import { loadConfigContext } from '../config-loader.js';
import { fetchHealth } from '../admin-client.js';

export interface StatusResult {
  reachable: boolean;
  health?: unknown;
  error?: string;
}

export async function runStatus(opts: { configPath?: string; timeoutMs?: number } = {}): Promise<StatusResult> {
  const ctx = loadConfigContext(opts.configPath);
  if (!ctx.config.health.enabled) {
    return { reachable: false, error: 'health endpoint disabled in config' };
  }
  const url = `http://${ctx.config.health.bind}:${ctx.config.health.port}/health`;
  try {
    const health = await fetchHealth(url, opts.timeoutMs);
    return { reachable: true, health };
  } catch (err) {
    return { reachable: false, error: (err as Error).message };
  }
}

export function formatStatus(result: StatusResult): string {
  if (!result.reachable) {
    return `rederd not reachable: ${result.error ?? 'unknown error'}`;
  }
  const h = result.health as {
    daemon: { uptime_s: number; version: string };
    adapters: Array<{ name: string; healthy: boolean }>;
    outbox: { inbound_pending: number; outbound_pending: number };
    sessions: Array<{ session_id: string; state: string; last_seen_at: string | null }>;
  };
  const lines: string[] = [
    `rederd v${h.daemon.version} — up ${h.daemon.uptime_s}s`,
    `Adapters: ${h.adapters.map((a) => `${a.name}${a.healthy ? '' : '(unhealthy)'}`).join(', ') || '(none)'}`,
    `Outbox: inbound=${h.outbox.inbound_pending} outbound=${h.outbox.outbound_pending}`,
    'Sessions:',
  ];
  for (const s of h.sessions) {
    const seen = s.last_seen_at ? ` (last seen ${s.last_seen_at})` : '';
    lines.push(`  - ${s.session_id} [${s.state}]${seen}`);
  }
  return lines.join('\n');
}
