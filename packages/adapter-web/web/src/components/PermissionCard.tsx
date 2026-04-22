import type { PendingPermission } from '../types';

interface PermissionCardProps {
  permission: PendingPermission;
  onDecide: (behavior: 'allow' | 'deny') => void;
  pending?: boolean;
}

export function PermissionCard({ permission, onDecide, pending }: PermissionCardProps): JSX.Element {
  return (
    <div
      className="self-stretch rounded-[10px] border bg-bg-2 p-3"
      style={{ borderColor: 'color-mix(in oklab, var(--st-busy) 55%, var(--line))' }}
    >
      <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.08em]" style={{ color: 'var(--st-busy)' }}>
        <span className="size-1.5 rounded-full animate-dot-blink" style={{ background: 'var(--st-busy)', boxShadow: '0 0 6px var(--st-busy)' }} />
        permission requested · {permission.toolName}
      </div>
      <div className="mt-1 text-[13.5px] text-fg">{permission.description}</div>
      {permission.inputPreview && (
        <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-[11px] text-fg-2">
          {permission.inputPreview}
        </pre>
      )}
      <div className="mt-2.5 flex justify-end gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => onDecide('deny')}
          className="qbtn danger disabled:opacity-50"
        >
          Deny
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => onDecide('allow')}
          className="qbtn primary disabled:opacity-50"
        >
          Allow
        </button>
      </div>
    </div>
  );
}
