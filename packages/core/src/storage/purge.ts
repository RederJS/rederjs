import type { Database as Db } from 'better-sqlite3';

export interface PurgeSessionResult {
  inbound: number;
  outbound: number;
  permissions: number;
  transcriptOffsets: number;
}

/**
 * Delete all conversation state for a single session: inbound/outbound
 * messages, permission requests, and the transcript-tail byte offset. Runs
 * in one transaction.
 *
 * Deliberately untouched:
 *   - `sessions`           — the session itself stays registered
 *   - `bindings`           — Telegram pairings etc. survive a clear
 *   - `persistent_approvals` — "always allow" decisions are user-explicit
 *   - `pair_codes`         — unrelated to conversation state
 *
 * Caller is responsible for wiping media on disk and for cancelling any
 * in-flight permission timers / unread counters in adjacent components.
 */
export function purgeSessionData(db: Db, sessionId: string): PurgeSessionResult {
  const tx = db.transaction(() => {
    const inbound = db
      .prepare('DELETE FROM inbound_messages WHERE session_id = ?')
      .run(sessionId).changes;
    const outbound = db
      .prepare('DELETE FROM outbound_messages WHERE session_id = ?')
      .run(sessionId).changes;
    const permissions = db
      .prepare('DELETE FROM permission_requests WHERE session_id = ?')
      .run(sessionId).changes;
    const transcriptOffsets = db
      .prepare('DELETE FROM transcript_offsets WHERE session_id = ?')
      .run(sessionId).changes;
    return { inbound, outbound, permissions, transcriptOffsets };
  });
  return tx();
}
