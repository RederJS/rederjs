import type { Status } from '../types';

const LABELS: Record<Status, string> = {
  working: 'working',
  'awaiting-user': 'needs you',
  idle: 'idle',
  unknown: 'unknown',
  offline: 'offline',
};

export function StatusPill({ status }: { status: Status }): JSX.Element {
  return (
    <span className="spill" data-s={status}>
      <span className="d" />
      {LABELS[status]}
    </span>
  );
}
