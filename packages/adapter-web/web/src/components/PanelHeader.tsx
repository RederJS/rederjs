import type { SessionSummary } from '../api';
import { sessionStatus, shortId } from '../derive';
import type { StatusVariant } from '../types';
import { Avatar } from './Avatar';
import { Icons } from './Icon';

interface PanelHeaderProps {
  session: SessionSummary;
  sessions: SessionSummary[];
  statusVariant: StatusVariant;
  onClose: () => void;
  onSwitchSession: (sessionId: string) => void;
}

export function PanelHeader({
  session,
  sessions,
  statusVariant,
  onClose,
  onSwitchSession,
}: PanelHeaderProps): JSX.Element {
  const status = sessionStatus(session);
  return (
    <div
      className="flex min-w-0 items-center gap-3 overflow-hidden border-b border-line px-4 py-3"
      style={{ background: 'color-mix(in oklab, var(--bg) 50%, var(--bg-1))' }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Back to dashboard"
        className="md:hidden grid size-9 place-items-center rounded-md text-fg-3 hover:bg-bg-2 hover:text-fg"
      >
        <Icons.chevL size={18} />
      </button>
      <div className="scale-[0.92]">
        <Avatar
          sessionId={session.session_id}
          name={session.display_name}
          status={status}
          variant={statusVariant}
          avatarUrl={session.avatar_url}
        />
      </div>
      <div className="relative min-w-0 flex-1">
        <div className="truncate text-sm font-semibold tracking-[-0.01em]">
          {session.display_name}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2.5 font-mono text-[11px] text-fg-3">
          <span className="shrink-0">
            id <b className="font-medium text-fg-2">{shortId(session.session_id)}</b>
          </span>
          {session.branch && (
            <>
              <span className="shrink-0">•</span>
              <span className="inline-flex min-w-0 items-center gap-1">
                <Icons.branch size={12} />
                <b className="min-w-0 truncate font-medium text-fg-2" title={session.branch}>
                  {session.branch}
                </b>
                {session.pr && (
                  <a
                    href={session.pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open PR #${session.pr.number} on GitHub`}
                    className="shrink-0 font-medium text-accent hover:underline"
                  >
                    #{session.pr.number}
                  </a>
                )}
              </span>
            </>
          )}
        </div>
        <select
          value={session.session_id}
          onChange={(e) => {
            const id = e.target.value;
            if (id !== session.session_id) onSwitchSession(id);
          }}
          aria-label="Switch session"
          className="md:hidden absolute inset-0 cursor-pointer opacity-0"
        >
          {sessions.map((s) => (
            <option key={s.session_id} value={s.session_id}>
              {s.display_name}
            </option>
          ))}
        </select>
      </div>
      <div className="hidden md:flex gap-0.5">
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
