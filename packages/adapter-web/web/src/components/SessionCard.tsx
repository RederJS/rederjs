import type { KeyboardEvent, MouseEvent } from 'react';
import type { SessionSummary } from '../api';
import { repairSession } from '../api';
import { sessionStatus, shortId } from '../derive';
import { formatLast, formatTokens, formatUptime } from '../format';
import type { CardVariant, StatusVariant } from '../types';
import { Avatar } from './Avatar';
import { StatusPill } from './StatusPill';
import { cn } from '../cn';

interface SessionCardProps {
  session: SessionSummary;
  preview: string | null;
  selected: boolean;
  variant: CardVariant;
  statusVariant: StatusVariant;
  onClick: () => void;
}

export function SessionCard({
  session,
  preview,
  selected,
  variant,
  statusVariant,
  onClick,
}: SessionCardProps): JSX.Element {
  const status = sessionStatus(session);
  const lastIso = session.last_inbound_at || session.last_outbound_at || session.last_seen_at;

  const handleKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  const handleRepair = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation();
    try {
      await repairSession(session.session_id);
    } catch (err) {
      alert(`Repair failed: ${(err as Error).message}`);
    }
  };

  const repairButton =
    status === 'unknown' ? (
      <button
        type="button"
        onClick={handleRepair}
        className="mt-1 self-start rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-3 hover:text-fg"
      >
        Repair hooks
      </button>
    ) : null;

  if (variant === 'compact') {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={handleKey}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg border border-line bg-bg-1 p-3 text-left transition',
          'hover:border-line-2 hover:bg-bg-2',
          selected && 'border-accent bg-bg-1 shadow-card-selected',
        )}
      >
        <Avatar
          sessionId={session.session_id}
          name={session.display_name}
          status={status}
          variant={statusVariant}
          size="sm"
        />
        <div className="flex-1 min-w-0">
          <div className="truncate text-sm font-semibold tracking-[-0.01em]">
            {session.display_name}
          </div>
          <div className="truncate font-mono text-[11px] text-fg-4">
            {shortId(session.session_id)}
          </div>
        </div>
        {statusVariant !== 'pill' ? null : <StatusPill status={status} />}
        {repairButton}
      </div>
    );
  }

  if (variant === 'panel') {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={handleKey}
        className={cn(
          '@container/card group relative flex min-h-[180px] w-full flex-col overflow-hidden rounded-[10px] border border-line text-left transition',
          'bg-gradient-to-b from-bg-1 to-bg-2',
          'hover:border-line-2',
          selected && 'border-accent shadow-card-selected',
        )}
      >
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line bg-bg px-3.5 py-3">
          <Avatar
            sessionId={session.session_id}
            name={session.display_name}
            status={status}
            variant={statusVariant}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-semibold tracking-[-0.01em]">
              {session.display_name}
            </span>
            <span className="font-mono text-[11px] text-fg-4">{shortId(session.session_id)}</span>
          </div>
          {statusVariant !== 'ringed' && <StatusPill status={status} />}
        </div>
        <div className="flex-1 px-3.5 py-2 text-[13px] leading-[1.5] text-fg-2 line-clamp-2 min-h-[2.9em]">
          <span className="mr-1.5 font-mono text-[11px] text-fg-4">›</span>
          {preview ?? (session.workspace_dir || 'No activity yet')}
        </div>
        <div
          className="grid grid-cols-4 gap-1 border-t border-line px-3.5 py-2.5 font-mono text-[10.5px] text-fg-3"
          style={{ background: 'color-mix(in oklab, var(--bg) 70%, #000)' }}
        >
          <MetaCell label="Up" value={formatUptime(null)} />
          <MetaCell label="Last" value={formatLast(lastIso)} />
          <MetaCell label="Tok" value={formatTokens(null)} />
          <MetaCell label="Unread" value={session.unread > 0 ? String(session.unread) : '—'} />
        </div>
        {repairButton && <div className="px-3.5 pb-2.5">{repairButton}</div>}
      </div>
    );
  }

  // tactical (default)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKey}
      className={cn(
        '@container/card group relative flex min-h-[170px] w-full flex-col gap-3 overflow-hidden rounded-[10px] border border-line bg-bg-1 p-4 text-left transition',
        'hover:border-line-2 hover:bg-bg-2',
        selected && 'border-accent bg-bg-1 shadow-card-selected',
      )}
    >
      <div className="flex flex-wrap items-center gap-2.5 @max-[210px]/card:gap-2">
        <Avatar
          sessionId={session.session_id}
          name={session.display_name}
          status={status}
          variant={statusVariant}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold tracking-[-0.01em] @max-[210px]/card:text-[13px]">
            {session.display_name}
          </span>
          <span className="font-mono text-[11px] text-fg-4 @max-[140px]/card:hidden">
            {shortId(session.session_id)}
          </span>
        </div>
        {statusVariant !== 'ringed' && (
          <span className="ml-auto @max-[210px]/card:ml-0 @max-[210px]/card:basis-full @max-[210px]/card:w-fit">
            <StatusPill status={status} />
          </span>
        )}
      </div>

      <div className="min-h-[2.9em] text-[13px] leading-[1.5] text-fg-2 line-clamp-2 @max-[170px]/card:line-clamp-3 @max-[170px]/card:text-[12.5px] @max-[140px]/card:line-clamp-4 @max-[140px]/card:text-[12px]">
        <span className="mr-1.5 font-mono text-[11px] text-fg-4">›</span>
        {preview ?? (session.workspace_dir || 'No activity yet')}
      </div>

      {status === 'working' && <div className="scanbar" />}

      <div className="mt-auto grid grid-cols-3 gap-x-2 gap-y-1 border-t border-dashed border-line pt-2.5 font-mono text-[10.5px] text-fg-3 @max-[170px]/card:grid-cols-1 @max-[140px]/card:hidden">
        <MetaCell label="Up" value={formatUptime(null)} />
        <MetaCell label="Last" value={formatLast(lastIso)} />
        <MetaCell label="Unread" value={session.unread > 0 ? String(session.unread) : '—'} />
      </div>
      {repairButton}
    </div>
  );
}

function MetaCell({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="text-[9.5px] uppercase tracking-[0.05em] text-fg-4">{label}</div>
      <div className="text-fg-2">{value}</div>
    </div>
  );
}
