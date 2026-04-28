import { useEffect, useMemo, useState } from 'react';
import { Panel } from './components/Panel';
import { SessionGrid } from './components/SessionGrid';
import { Topbar } from './components/Topbar';
import { Tweaks } from './components/Tweaks';
import { sessionStatus } from './derive';
import { useSessionsState } from './hooks/useSessionsState';
import { useSystemStats } from './hooks/useSystemStats';
import { useTweaks } from './hooks/useTweaks';
import { navigate, parseRoute, useHashRoute } from './router';
import { startSession } from './api';
import type { SortKey, Status } from './types';
import { cn } from './cn';

export function App(): JSX.Element {
  const { sessions, previews, loading, error } = useSessionsState();
  const stats = useSystemStats();
  const { tweaks, setTweak } = useTweaks();
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<Status | 'all'>('all');
  const [sort, setSort] = useState<SortKey>('priority');

  const hash = useHashRoute();
  const route = parseRoute(hash);
  const selectedId = route.page === 'detail' ? (route.sessionId ?? null) : null;
  const selectedSession = useMemo(
    () => (selectedId ? (sessions.find((s) => s.session_id === selectedId) ?? null) : null),
    [sessions, selectedId],
  );

  useEffect(() => {
    if (selectedId && sessions.length > 0 && !selectedSession) {
      navigate('/');
    }
  }, [selectedId, selectedSession, sessions.length]);

  const attentionCount = useMemo(
    () => sessions.filter((s) => sessionStatus(s) === 'awaiting-user').length,
    [sessions],
  );

  const panelOpen = !!selectedSession;
  const panelVariant = tweaks.panel;

  const openSession = (id: string): void => {
    if (selectedId === id) {
      navigate('/');
    } else {
      navigate(`/s/${id}`);
    }
  };

  const handleNewSession = async (): Promise<void> => {
    const notStarted = sessions.filter((s) => !s.tmux_running && s.workspace_dir);
    if (notStarted.length === 0) {
      alert('No configured sessions ready to start. Add one to reder.config.yaml first.');
      return;
    }
    const names = notStarted.map((s) => `- ${s.display_name} (${s.session_id})`).join('\n');
    const input = prompt(`Start which session?\n${names}`, notStarted[0]!.session_id);
    if (!input) return;
    try {
      await startSession(input.trim());
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <div className="app-bg relative h-[100dvh]">
      <main
        className="relative grid h-full min-h-0 min-w-0"
        style={{ gridTemplateRows: 'auto 1fr' }}
      >
        <Topbar
          waitingCount={attentionCount}
          stats={stats}
          theme={tweaks.theme}
          onToggleTheme={() => setTweak('theme', tweaks.theme === 'dark' ? 'light' : 'dark')}
          onOpenTweaks={() => setTweaksOpen((v) => !v)}
          onNewSession={() => void handleNewSession()}
          onLogoClick={() => navigate('/')}
        />

        <div
          data-panel={panelVariant}
          data-open={panelOpen || undefined}
          className="content-grid relative grid min-h-0 min-w-0 overflow-hidden transition-[grid-template-columns] duration-[320ms] ease-spring-out"
        >
          {loading && sessions.length === 0 ? (
            <div className="grid place-items-center text-sm text-fg-4">Loading sessions…</div>
          ) : error && sessions.length === 0 ? (
            <div className="grid place-items-center p-8 text-sm text-[#ff8a8a]">{error}</div>
          ) : (
            <SessionGrid
              sessions={sessions}
              previews={previews}
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
              sort={sort}
              onSortChange={setSort}
              cols={tweaks.cols}
              onColsChange={(n) => setTweak('cols', n)}
              selectedId={selectedId}
              onSelect={openSession}
              cardVariant={tweaks.card}
              statusVariant={tweaks.status}
            />
          )}

          {selectedSession && (() => {
            const panelEl = (
              <Panel
                session={selectedSession}
                sessions={sessions}
                statusVariant={tweaks.status}
                bubbleVariant={tweaks.bubble}
                composerVariant={tweaks.composer}
                onClose={() => navigate('/')}
                onSwitchSession={openSession}
              />
            );
            if (panelVariant !== 'overlay') return panelEl;
            return (
              <div
                className={cn(
                  'absolute bottom-0 right-0 top-0 z-[5] w-full md:w-[min(620px,60%)] transition-transform duration-300 ease-spring-out',
                  panelOpen ? 'translate-x-0' : 'translate-x-full',
                )}
                style={{ boxShadow: '-30px 0 60px -10px #000' }}
              >
                {panelEl}
              </div>
            );
          })()}
        </div>
      </main>

      {tweaksOpen && (
        <Tweaks tweaks={tweaks} setTweak={setTweak} onClose={() => setTweaksOpen(false)} />
      )}
    </div>
  );
}
