import type { SessionSummary } from '../api';
import { deriveStatus, shortId } from '../derive';
import type { StatusVariant } from '../types';
import { Avatar } from './Avatar';
import { Icons } from './Icon';

interface PanelHeaderProps {
  session: SessionSummary;
  statusVariant: StatusVariant;
  onClose: () => void;
}

export function PanelHeader({ session, statusVariant, onClose }: PanelHeaderProps): JSX.Element {
  const status = deriveStatus(session);
  return (
    <div
      className="flex items-center gap-3 border-b border-line px-4 py-3"
      style={{ background: 'color-mix(in oklab, var(--bg) 50%, var(--bg-1))' }}
    >
      <div className="scale-[0.92]">
        <Avatar sessionId={session.session_id} name={session.display_name} status={status} variant={statusVariant} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold tracking-[-0.01em]">{session.display_name}</div>
        <div className="mt-0.5 flex gap-2.5 font-mono text-[11px] text-fg-3">
          <span>
            id <b className="font-medium text-fg-2">{shortId(session.session_id)}</b>
          </span>
          {session.workspace_dir && (
            <>
              <span>•</span>
              <span className="inline-flex items-center gap-1 truncate">
                <Icons.folder size={12} />{' '}
                <b className="truncate font-medium text-fg-2">{session.workspace_dir}</b>
              </span>
            </>
          )}
        </div>
      </div>
      <div className="flex gap-0.5">
        <IconBtn title="Pin" disabled>
          <Icons.pin size={15} />
        </IconBtn>
        <IconBtn title="Settings" disabled>
          <Icons.settings size={15} />
        </IconBtn>
        <IconBtn title="Close" onClick={onClose}>
          <Icons.close size={15} />
        </IconBtn>
      </div>
    </div>
  );
}

function IconBtn({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="grid size-8 place-items-center rounded-md text-fg-3 transition-colors hover:bg-bg-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-3"
    >
      {children}
    </button>
  );
}
