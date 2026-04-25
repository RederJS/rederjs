import { useEffect, useState } from 'react';
import { getSystemStats, type SystemStats } from '../api';

const POLL_MS = 3_000;

export function useSystemStats(): SystemStats | null {
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const tick = async (): Promise<void> => {
      try {
        const next = await getSystemStats();
        if (!cancelled) setStats(next);
      } catch {
        // ignore — keep last good value, retry on the next tick
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  return stats;
}
