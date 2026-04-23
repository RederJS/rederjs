/**
 * Sliding-window rate limiter keyed by an opaque string. Thread-unsafe by design
 * (reder runs single-process); the map size is bounded by ad-hoc sweeps.
 */

export interface RateLimitCheck {
  allowed: boolean;
  resetInMs?: number;
  currentCount: number;
}

export class RateLimiter {
  private windows = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60_000,
  ) {}

  check(key: string, now: number = Date.now()): RateLimitCheck {
    const cutoff = now - this.windowMs;
    const existing = this.windows.get(key) ?? [];
    const recent: number[] = [];
    for (const t of existing) if (t > cutoff) recent.push(t);

    if (recent.length >= this.limit) {
      const first = recent[0]!;
      return {
        allowed: false,
        resetInMs: Math.max(1, first + this.windowMs - now),
        currentCount: recent.length,
      };
    }

    recent.push(now);
    this.windows.set(key, recent);
    return { allowed: true, currentCount: recent.length };
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  sweep(now: number = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.windows) {
      const kept = timestamps.filter((t) => t > cutoff);
      if (kept.length === 0) this.windows.delete(key);
      else this.windows.set(key, kept);
    }
  }
}
