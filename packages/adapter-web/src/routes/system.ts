import { Router as expressRouter, type Request, type Response } from 'express';

export interface SystemStatsSnapshot {
  /** Resident set size in bytes. */
  rss_bytes: number;
  /** Heap used in bytes. */
  heap_used_bytes: number;
  /** CPU usage as a percentage of one core over the sampling window. */
  cpu_percent: number;
  /** Process uptime in seconds. */
  uptime_seconds: number;
}

interface CpuSample {
  cpu: { user: number; system: number };
  hrtime: bigint;
}

/**
 * Tracks the previous CPU sample so each call to /api/system/stats reports
 * usage over the window since the last poll. Module-level state is fine —
 * one daemon process, one route handler instance.
 */
function makeCpuMeter(): () => number {
  let last: CpuSample = {
    cpu: process.cpuUsage(),
    hrtime: process.hrtime.bigint(),
  };
  return (): number => {
    const cpu = process.cpuUsage();
    const hr = process.hrtime.bigint();
    const elapsedMicros = Number(hr - last.hrtime) / 1_000;
    const usedMicros = cpu.user + cpu.system - (last.cpu.user + last.cpu.system);
    last = { cpu, hrtime: hr };
    if (elapsedMicros <= 0) return 0;
    return Math.max(0, (usedMicros / elapsedMicros) * 100);
  };
}

export function createSystemRouter(): ReturnType<typeof expressRouter> {
  const r = expressRouter();
  const sampleCpu = makeCpuMeter();
  r.get('/system/stats', (_req: Request, res: Response) => {
    const mem = process.memoryUsage();
    const snap: SystemStatsSnapshot = {
      rss_bytes: mem.rss,
      heap_used_bytes: mem.heapUsed,
      cpu_percent: sampleCpu(),
      uptime_seconds: process.uptime(),
    };
    res.json(snap);
  });
  return r;
}
