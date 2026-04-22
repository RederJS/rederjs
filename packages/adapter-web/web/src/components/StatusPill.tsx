import type { Status } from '../types';

export function StatusPill({ status }: { status: Status }): JSX.Element {
  return (
    <span className="spill" data-s={status}>
      <span className="d" />
      {status}
    </span>
  );
}
