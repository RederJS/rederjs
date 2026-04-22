import { avatarColor, initials } from '../derive';
import type { Status, StatusVariant } from '../types';
import { cn } from '../cn';

interface AvatarProps {
  sessionId: string;
  name: string;
  status: Status;
  variant?: StatusVariant;
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_PX = { sm: 28, md: 36, lg: 48 } as const;
const FONT_PX = { sm: 10, md: 13, lg: 15 } as const;

export function Avatar({ sessionId, name, status, variant = 'ringed', size = 'md' }: AvatarProps): JSX.Element {
  const px = SIZE_PX[size];
  const fontPx = FONT_PX[size];
  const color = avatarColor(sessionId);

  return (
    <span
      className="relative inline-block shrink-0 align-middle"
      data-status={status}
      style={{ width: px, height: px }}
    >
      <span
        className={cn('avatar-frame', 'grid place-items-center rounded-full font-mono font-bold text-[#0b0c0f] relative')}
        style={{ width: px, height: px, fontSize: fontPx, background: color }}
      >
        {initials(name)}
      </span>
      {variant === 'ringed' && <span className="avatar-ring" />}
      {variant === 'corner' && (
        <span
          className={cn(
            'absolute bottom-0 right-0 block size-2.5 rounded-full border-2',
            'border-bg',
          )}
          style={{ background: `var(--st-${status})`, boxShadow: `0 0 6px var(--st-${status})` }}
        />
      )}
    </span>
  );
}
