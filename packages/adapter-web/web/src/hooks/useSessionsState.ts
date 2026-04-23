import { useCallback, useEffect, useState } from 'react';
import { listMessages, listSessions, type SessionSummary } from '../api';
import { useEventStream } from '../sse';

const REFRESH_INTERVAL_MS = 30_000;

export interface SessionsState {
  sessions: SessionSummary[];
  previews: Map<string, string>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  refreshPreview: (sessionId: string) => Promise<void>;
}

export function useSessionsState(): SessionsState {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [previews, setPreviews] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPreviewsFor = useCallback(
    async (list: SessionSummary[]): Promise<Map<string, string>> => {
      const map = new Map<string, string>();
      const runners = list.map(async (s) => {
        try {
          const msgs = await listMessages(s.session_id, { limit: 5 });
          const latest = msgs.find((m) => m.direction === 'outbound' && m.content);
          if (latest) {
            const single = latest.content.replace(/\n+/g, ' ').trim();
            map.set(s.session_id, single);
          }
        } catch {
          // ignore per-session preview failure
        }
      });
      await Promise.allSettled(runners);
      return map;
    },
    [],
  );

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await listSessions();
      setSessions(list);
      setError(null);
      const p = await loadPreviewsFor(list);
      setPreviews(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loadPreviewsFor]);

  const refreshPreview = useCallback(async (sessionId: string): Promise<void> => {
    try {
      const msgs = await listMessages(sessionId, { limit: 5 });
      const latest = msgs.find((m) => m.direction === 'outbound' && m.content);
      if (latest) {
        const single = latest.content.replace(/\n+/g, ' ').trim();
        setPreviews((prev) => {
          const next = new Map(prev);
          next.set(sessionId, single);
          return next;
        });
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEventStream('/api/stream', (name, data) => {
    if (
      name === 'inbound' ||
      name === 'outbound' ||
      name === 'outbound.persisted' ||
      name === 'session.state_changed' ||
      name === 'session.activity_changed'
    ) {
      void refresh();
      if (name === 'outbound' || name === 'outbound.persisted') {
        const payload = data as { sessionId?: string } | undefined;
        if (payload?.sessionId) void refreshPreview(payload.sessionId);
      }
    }
  });

  return { sessions, previews, loading, error, refresh, refreshPreview };
}
