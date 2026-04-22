import type { ChangeEvent } from 'react';
import { Icons } from './Icon';

interface TopbarProps {
  sessionsCount: number;
  waitingCount: number;
  search: string;
  onSearchChange: (value: string) => void;
  onNewSession?: () => void;
}

export function Topbar({
  sessionsCount,
  waitingCount,
  search,
  onSearchChange,
  onNewSession,
}: TopbarProps): JSX.Element {
  const host =
    typeof window !== 'undefined' && window.location.hostname
      ? window.location.hostname
      : 'localhost';

  return (
    <div className="topbar-bg relative z-[2] flex items-center gap-4 border-b border-line px-5 py-3.5">
      <div className="flex items-baseline gap-px font-mono text-[18px] font-bold tracking-[-0.02em]">
        <span>reder</span>
        <span
          className="ml-[3px] inline-block h-[18px] w-[9px] translate-y-[3px] bg-accent animate-caret-blink"
          aria-hidden
        />
      </div>

      <div className="flex h-[22px] items-center gap-2.5 border-l border-line pl-4 font-mono text-xs text-fg-3">
        <span className="breadcrumb-dot" aria-hidden />
        <span>
          host <span className="text-fg-2">{host}</span>
        </span>
        <span className="text-fg-4">/</span>
        <span>
          sessions <span className="text-fg-2">{sessionsCount}</span>
        </span>
        {waitingCount > 0 && (
          <>
            <span className="text-fg-4">/</span>
            <span>
              waiting <span className="text-fg-2">{waitingCount}</span>
            </span>
          </>
        )}
      </div>

      <div className="flex-1" />

      <label className="flex w-[280px] items-center gap-2 rounded-lg border border-line bg-bg-2 px-2.5 py-1.5 font-mono text-xs text-fg-3">
        <Icons.search size={14} />
        <input
          type="text"
          value={search}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onSearchChange(e.target.value)}
          placeholder="search sessions…"
          className="flex-1 border-0 bg-transparent text-fg outline-none placeholder:text-fg-4"
        />
        <kbd className="rounded border border-line-2 bg-bg-1 px-1.5 py-0.5 text-[10px] text-fg-3">
          ⌘K
        </kbd>
      </label>

      <button
        type="button"
        onClick={onNewSession}
        className="flex items-center gap-1.5 rounded-md border border-line bg-bg-2 px-3 py-1.5 font-mono text-xs text-fg-2 transition-colors hover:border-accent hover:text-accent"
        title="New session"
      >
        <Icons.plus size={14} />
        new session
      </button>
    </div>
  );
}
