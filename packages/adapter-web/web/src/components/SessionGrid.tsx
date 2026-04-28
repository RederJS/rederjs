import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { SessionSummary } from '../api';
import { sessionStatus } from '../derive';
import type { CardVariant, SortKey, Status, StatusVariant } from '../types';
import { SessionCard } from './SessionCard';
import { cn } from '../cn';

interface SessionGridProps {
  sessions: SessionSummary[];
  previews: Map<string, string>;
  statusFilter: Status | 'all';
  onStatusFilterChange: (s: Status | 'all') => void;
  sort: SortKey;
  onSortChange: (s: SortKey) => void;
  cols: number;
  onColsChange: (n: number) => void;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  cardVariant: CardVariant;
  statusVariant: StatusVariant;
}

const STATUS_ORDER: Record<Status, number> = {
  'awaiting-user': 0,
  unknown: 1,
  offline: 2,
  idle: 3,
  working: 4,
};

export function SessionGrid(props: SessionGridProps): JSX.Element {
  const {
    sessions,
    previews,
    statusFilter,
    onStatusFilterChange,
    sort,
    onSortChange,
    cols,
    onColsChange,
    selectedId,
    onSelect,
    cardVariant,
    statusVariant,
  } = props;

  const counts = useMemo(() => {
    const out: Record<Status, number> = {
      working: 0,
      'awaiting-user': 0,
      idle: 0,
      unknown: 0,
      offline: 0,
    };
    for (const s of sessions) out[sessionStatus(s)]++;
    return out;
  }, [sessions]);

  const filtered = useMemo(() => {
    const list = sessions.filter(
      (s) => statusFilter === 'all' || sessionStatus(s) === statusFilter,
    );
    list.sort((a, b) => {
      if (sort === 'priority') {
        const d = STATUS_ORDER[sessionStatus(a)] - STATUS_ORDER[sessionStatus(b)];
        if (d !== 0) return d;
        return a.display_name.localeCompare(b.display_name);
      }
      if (sort === 'recent') {
        const aRaw = a.last_inbound_at || a.last_outbound_at || a.last_seen_at || '';
        const bRaw = b.last_inbound_at || b.last_outbound_at || b.last_seen_at || '';
        return Date.parse(bRaw) - Date.parse(aRaw);
      }
      return a.display_name.localeCompare(b.display_name);
    });
    return list;
  }, [sessions, statusFilter, sort]);

  const gridStyle: CSSProperties = { ['--cols' as any]: cols };

  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-auto px-3 pb-6 pt-4 md:px-5 md:pb-10 md:pt-6">
      <div className="mb-4 flex flex-wrap items-center gap-3.5 font-mono text-xs">
        <span className="font-semibold text-fg">
          {filtered.length}
          <em className="not-italic font-normal text-fg-4"> / {sessions.length}</em>
        </span>
        <span className="h-3.5 w-px bg-line" />

        <select
          value={statusFilter}
          onChange={(e) => onStatusFilterChange(e.target.value as Status | 'all')}
          className="md:hidden rounded-md border border-line bg-bg-1 px-2.5 py-1 text-fg-2 font-mono text-xs"
          aria-label="Status filter"
        >
          <option value="all">all ({sessions.length})</option>
          {(['awaiting-user', 'idle', 'unknown', 'working', 'offline'] as const).map((s) => (
            <option key={s} value={s}>
              {s === 'awaiting-user' ? 'needs you' : s} ({counts[s]})
            </option>
          ))}
        </select>

        <div className="hidden md:flex gap-1.5">
          <Chip active={statusFilter === 'all'} onClick={() => onStatusFilterChange('all')}>
            all <span className="text-fg-4">{sessions.length}</span>
          </Chip>
          {(['awaiting-user', 'idle', 'unknown', 'working', 'offline'] as const).map((s) => (
            <Chip key={s} active={statusFilter === s} onClick={() => onStatusFilterChange(s)}>
              <span className="size-1.5 rounded-full" style={{ background: `var(--st-${s})` }} />
              {s === 'awaiting-user' ? 'needs you' : s}{' '}
              <span className="text-fg-4">{counts[s]}</span>
            </Chip>
          ))}
        </div>

        <div className="flex-1" />

        <label className="hidden md:flex items-center gap-2 rounded-md border border-line bg-bg-1 px-2.5 py-1 text-fg-3">
          cols
          <input
            type="range"
            min={2}
            max={8}
            value={cols}
            onChange={(e) => onColsChange(Number(e.target.value))}
            className="cols-slider-range"
          />
          <span className="min-w-[10px] text-center text-[11px] text-fg">{cols}</span>
        </label>

        <select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SortKey)}
          className="md:hidden rounded-md border border-line bg-bg-1 px-2.5 py-1 text-fg-2 font-mono text-xs"
          aria-label="Sort"
        >
          {(['priority', 'recent', 'name'] as const).map((k) => (
            <option key={k} value={k}>
              sort: {k}
            </option>
          ))}
        </select>

        <div className="hidden md:flex gap-px rounded-md border border-line p-0.5">
          {(['priority', 'recent', 'name'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => onSortChange(k)}
              className={cn(
                'rounded-[4px] px-2 py-0.5 text-[11px] text-fg-3',
                sort === k && 'bg-bg-3 text-fg',
              )}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="grid flex-1 place-items-center py-16 text-sm text-fg-4">
          no sessions match the current filter.
        </div>
      ) : (
        <div data-card={cardVariant} className="sessions-grid grid gap-3.5" style={gridStyle}>
          {filtered.map((s) => (
            <SessionCard
              key={s.session_id}
              session={s}
              preview={previews.get(s.session_id) ?? null}
              selected={s.session_id === selectedId}
              onClick={() => onSelect(s.session_id)}
              variant={cardVariant}
              statusVariant={statusVariant}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
        active
          ? 'border-accent bg-[color-mix(in_oklab,var(--accent)_10%,transparent)] text-fg'
          : 'border-line bg-bg-1 text-fg-3 hover:border-line-2 hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}
