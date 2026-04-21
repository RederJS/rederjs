import { useEffect, useState } from 'react';

/** Minimal hash-based router. Returns the current route hash (without `#`). */
export function useHashRoute(): string {
  const [route, setRoute] = useState<string>(
    (typeof window !== 'undefined' ? window.location.hash.slice(1) : '') || '/',
  );
  useEffect(() => {
    const onChange = (): void => setRoute(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export function parseRoute(route: string): { page: 'list' | 'detail'; sessionId?: string } {
  const m = /^\/s\/([^/]+)$/.exec(route);
  if (m) return { page: 'detail', sessionId: m[1]! };
  return { page: 'list' };
}
