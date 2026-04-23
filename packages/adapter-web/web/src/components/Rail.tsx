import { Icons, type IconName } from './Icon';
import { cn } from '../cn';
import type { Theme } from '../types';

interface RailBtnProps {
  icon: IconName;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title: string;
}

function RailBtn({ icon, active, disabled, onClick, title }: RailBtnProps): JSX.Element {
  const Icon = Icons[icon];
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? `${title} (coming soon)` : title}
      aria-label={title}
      className={cn(
        'grid size-9 place-items-center rounded-lg text-fg-3 transition-colors',
        'hover:bg-bg-2 hover:text-fg',
        active &&
          'bg-bg-3 text-accent shadow-[inset_0_0_0_1px_var(--line-2)] hover:text-accent hover:bg-bg-3',
        disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent hover:text-fg-3',
      )}
    >
      {Icon ? <Icon size={18} /> : null}
    </button>
  );
}

interface RailProps {
  theme: Theme;
  onToggleTheme: () => void;
  onOpenTweaks: () => void;
}

export function Rail({ theme, onToggleTheme, onOpenTweaks }: RailProps): JSX.Element {
  return (
    <aside
      className="relative z-[3] flex flex-col items-center gap-1 border-r border-line py-3"
      style={{ background: 'color-mix(in oklab, var(--bg) 70%, #000)' }}
    >
      <div
        className="mb-2 grid size-8 place-items-center rounded-md bg-accent font-mono text-[13px] font-extrabold text-[color:#0b0c0f]"
        style={{ boxShadow: '0 0 0 1px var(--accent), 0 0 24px var(--glow)' }}
        aria-label="reder"
      >
        R
      </div>
      <RailBtn icon="grid" active title="Sessions" />
      <RailBtn icon="terminal" disabled title="Terminal" />
      <RailBtn icon="cpu" disabled title="Usage" />
      <RailBtn icon="bell" disabled title="Notifications" />
      <div className="flex-1" />
      <RailBtn
        icon={theme === 'dark' ? 'sun' : 'moon'}
        onClick={onToggleTheme}
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      />
      <RailBtn icon="settings" onClick={onOpenTweaks} title="Tweaks" />
    </aside>
  );
}
