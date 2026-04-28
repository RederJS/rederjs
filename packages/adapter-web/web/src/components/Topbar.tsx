import { Icons } from './Icon';
import type { SystemStats } from '../api';
import type { Theme } from '../types';

interface TopbarProps {
  waitingCount: number;
  stats: SystemStats | null;
  theme: Theme;
  onToggleTheme: () => void;
  onOpenTweaks: () => void;
  onNewSession?: () => void;
  onLogoClick?: () => void;
}

function formatPercent(percent: number): string {
  if (percent < 1) return `${percent.toFixed(1)}%`;
  return `${percent.toFixed(0)}%`;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}

export function Topbar({
  waitingCount,
  stats,
  theme,
  onToggleTheme,
  onOpenTweaks,
  onNewSession,
  onLogoClick,
}: TopbarProps): JSX.Element {
  const host =
    typeof window !== 'undefined' && window.location.hostname
      ? window.location.hostname
      : 'localhost';

  return (
    <header className="topbar-bg relative z-[2] flex items-center gap-2 md:gap-4 border-b border-line px-3 py-2.5 md:px-5 md:py-3.5">
      <button
        type="button"
        onClick={onLogoClick}
        title="Back to dashboard"
        aria-label="Back to dashboard"
        className="flex items-baseline gap-px font-mono text-[18px] font-bold tracking-[-0.02em] transition-colors hover:text-accent"
      >
        <span>reder</span>
        <span
          className="ml-[3px] inline-block h-[18px] w-[9px] translate-y-[3px] bg-accent animate-caret-blink"
          aria-hidden
        />
      </button>

      <div className="hidden md:flex h-[22px] items-center gap-2.5 border-l border-line pl-4 font-mono text-xs text-fg-3">
        <span className="breadcrumb-dot" aria-hidden />
        <span>
          host <span className="text-fg-2">{host}</span>
        </span>
        <span className="text-fg-4">/</span>
        <span
          title={
            stats
              ? `system CPU averaged across ${stats.cpu_per_core.length} core${stats.cpu_per_core.length === 1 ? '' : 's'}: ${stats.cpu_per_core.map((c) => `${c.toFixed(0)}%`).join(' ')}`
              : 'system CPU usage (sampled every 3s)'
          }
        >
          cpu{' '}
          <span className="text-fg-2 tabular-nums">
            {stats ? formatPercent(stats.cpu_percent) : '—'}
          </span>
        </span>
        <span className="text-fg-4">/</span>
        <span
          title={
            stats
              ? `system memory: ${formatBytes(stats.mem_used_bytes)} of ${formatBytes(stats.mem_total_bytes)} used`
              : 'system memory usage'
          }
        >
          mem{' '}
          <span className="text-fg-2 tabular-nums">
            {stats ? formatPercent(stats.mem_percent) : '—'}
          </span>
        </span>
        {waitingCount > 0 && (
          <>
            <span className="text-fg-4">/</span>
            <span>
              needs you <span className="text-fg-2">{waitingCount}</span>
            </span>
          </>
        )}
      </div>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onToggleTheme}
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        className="grid size-9 place-items-center rounded-md border border-line bg-bg-2 text-fg-3 transition-colors hover:border-accent hover:text-accent"
      >
        {theme === 'dark' ? <Icons.sun size={16} /> : <Icons.moon size={16} />}
      </button>

      <button
        type="button"
        onClick={onOpenTweaks}
        title="Tweaks"
        aria-label="Tweaks"
        className="grid size-9 place-items-center rounded-md border border-line bg-bg-2 text-fg-3 transition-colors hover:border-accent hover:text-accent"
      >
        <Icons.settings size={16} />
      </button>

      <button
        type="button"
        onClick={onNewSession}
        className="flex items-center gap-1.5 rounded-md border border-line bg-bg-2 p-2 md:px-3 md:py-1.5 font-mono text-xs text-fg-2 transition-colors hover:border-accent hover:text-accent"
        title="New session"
        aria-label="New session"
      >
        <Icons.plus size={14} />
        <span className="hidden md:inline">new session</span>
      </button>
    </header>
  );
}
