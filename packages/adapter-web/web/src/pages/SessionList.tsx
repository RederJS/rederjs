import { useEffect, useState } from 'react';
import { listSessions, startSession, type SessionSummary } from '../api';
import { useEventStream } from '../sse';
import { navigate } from '../router';

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

function Dot({ on, label }: { on: boolean; label: string }): JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs"
      title={label}
    >
      <span
        className={`h-2 w-2 rounded-full ${on ? 'bg-ok' : 'bg-muted'}`}
        aria-hidden
      />
      <span className={on ? 'text-slate-300' : 'text-muted'}>{label}</span>
    </span>
  );
}

export function SessionList(): JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      setSessions(await listSessions());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, []);

  useEventStream('/api/stream', (name) => {
    if (name === 'inbound' || name === 'outbound' || name === 'session.state_changed') {
      void refresh();
    }
  });

  const handleStart = async (sessionId: string): Promise<void> => {
    setBusy(sessionId);
    try {
      await startSession(sessionId);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
          <p className="text-sm text-muted">
            Claude Code workspaces managed by reder.
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          className="rounded-md border border-border bg-panel px-3 py-1.5 text-sm hover:bg-panel2"
        >
          Refresh
        </button>
      </header>

      {err && (
        <div className="mb-4 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">
          {err}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : sessions.length === 0 ? (
        <div className="rounded-lg border border-border bg-panel p-8 text-center text-muted">
          No sessions configured. Add entries under <code>sessions:</code> in your
          <code> reder.config.yaml</code>.
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {sessions.map((s) => (
            <li
              key={s.session_id}
              className="group cursor-pointer rounded-lg border border-border bg-panel p-4 transition hover:border-accent hover:bg-panel2"
              onClick={() => navigate(`/s/${s.session_id}`)}
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-lg font-medium text-slate-100">
                      {s.display_name}
                    </h2>
                    {s.unread > 0 && (
                      <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-canvas">
                        {s.unread}
                      </span>
                    )}
                  </div>
                  <div className="truncate font-mono text-xs text-muted">
                    {s.workspace_dir ?? s.session_id}
                  </div>
                </div>
                {!s.tmux_running && s.workspace_dir && (
                  <button
                    disabled={busy === s.session_id}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleStart(s.session_id);
                    }}
                    className="shrink-0 rounded-md border border-border bg-panel2 px-2.5 py-1 text-xs text-slate-300 hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    {busy === s.session_id ? 'Starting…' : 'Start'}
                  </button>
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <Dot on={s.shim_connected} label="shim" />
                <Dot on={s.tmux_running} label="tmux" />
                <span className="text-xs text-muted">
                  last msg {fmtTime(s.last_inbound_at ?? s.last_outbound_at)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
