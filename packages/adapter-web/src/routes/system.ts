import { readFileSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { Router as expressRouter, type Request, type Response } from 'express';

export interface SystemStatsSnapshot {
  /** Average CPU usage across all cores over the sampling window, 0–100. */
  cpu_percent: number;
  /** Per-core CPU usage over the sampling window, 0–100 each. */
  cpu_per_core: number[];
  /** Used system memory in bytes (excluding cache/buffers when available). */
  mem_used_bytes: number;
  /** Total system memory in bytes. */
  mem_total_bytes: number;
  /** Used memory as a percentage of total, 0–100. */
  mem_percent: number;
  /** Daemon process uptime in seconds. */
  uptime_seconds: number;
}

interface PerCoreSample {
  total: number;
  idle: number;
}

function sampleCores(): PerCoreSample[] {
  return cpus().map((c) => {
    const t = c.times;
    return {
      total: t.user + t.nice + t.sys + t.idle + t.irq,
      idle: t.idle,
    };
  });
}

/**
 * Tracks the previous CPU sample so each call reports usage over the window
 * since the last poll. CPU times in node:os are cumulative jiffies per core,
 * so we diff the current snapshot against the previous one.
 */
function makeCpuMeter(): () => { avg: number; perCore: number[] } {
  let last: PerCoreSample[] = sampleCores();
  return (): { avg: number; perCore: number[] } => {
    const cur = sampleCores();
    const perCore: number[] = [];
    let avgUsed = 0;
    let avgTotal = 0;
    for (let i = 0; i < cur.length; i++) {
      const prev = last[i];
      if (!prev) {
        perCore.push(0);
        continue;
      }
      const dTotal = cur[i]!.total - prev.total;
      const dIdle = cur[i]!.idle - prev.idle;
      const used = dTotal > 0 ? Math.max(0, ((dTotal - dIdle) / dTotal) * 100) : 0;
      perCore.push(used);
      avgUsed += dTotal - dIdle;
      avgTotal += dTotal;
    }
    last = cur;
    const avg = avgTotal > 0 ? Math.max(0, (avgUsed / avgTotal) * 100) : 0;
    return { avg, perCore };
  };
}

/**
 * Linux exposes `MemAvailable` in /proc/meminfo, which is the kernel's estimate
 * of free memory accounting for reclaimable cache. This matches what htop and
 * `free -h` show as "available", and is what users intuitively expect. On
 * non-Linux or if the file is unreadable we fall back to os.freemem(), which
 * undercounts available memory because it excludes the page cache.
 */
function readAvailableMemory(): number {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8');
    const m = text.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (m && m[1]) return Number(m[1]) * 1024;
  } catch {
    // ignore — fall through to freemem
  }
  return freemem();
}

export function createSystemRouter(): ReturnType<typeof expressRouter> {
  const r = expressRouter();
  const sampleCpu = makeCpuMeter();
  r.get('/system/stats', (_req: Request, res: Response) => {
    const cpu = sampleCpu();
    const total = totalmem();
    const available = readAvailableMemory();
    const used = Math.max(0, total - available);
    const snap: SystemStatsSnapshot = {
      cpu_percent: cpu.avg,
      cpu_per_core: cpu.perCore,
      mem_used_bytes: used,
      mem_total_bytes: total,
      mem_percent: total > 0 ? (used / total) * 100 : 0,
      uptime_seconds: process.uptime(),
    };
    res.set('Cache-Control', 'no-store');
    res.json(snap);
  });
  return r;
}
