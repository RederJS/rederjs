import type { Database as Db } from 'better-sqlite3';

export interface TranscriptMessage {
  messageId: string;
  direction: 'inbound' | 'outbound';
  sessionId: string;
  adapter: string;
  /** Inbound: sender_id. Outbound: recipient. */
  party: string;
  content: string;
  meta: Record<string, string>;
  files: string[];
  timestamp: string;
  state: string;
}

export interface TranscriptQuery {
  sessionId: string;
  /** ISO cursor — return messages strictly earlier than this timestamp. */
  before?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export function listTranscript(db: Db, q: TranscriptQuery): TranscriptMessage[] {
  const limit = Math.min(Math.max(1, q.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  const inbound = db
    .prepare(
      `SELECT message_id, session_id, adapter, sender_id AS party,
              content, meta_json, files_json, received_at AS ts, state
         FROM inbound_messages
        WHERE session_id = ? ${q.before ? 'AND received_at < ?' : ''}
        ORDER BY received_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(...(q.before ? [q.sessionId, q.before, limit] : [q.sessionId, limit])) as Array<{
    message_id: string;
    session_id: string;
    adapter: string;
    party: string;
    content: string;
    meta_json: string;
    files_json: string;
    ts: string;
    state: string;
  }>;

  const outbound = db
    .prepare(
      `SELECT message_id, session_id, adapter, recipient AS party,
              content, meta_json, files_json, created_at AS ts, state
         FROM outbound_messages
        WHERE session_id = ? ${q.before ? 'AND created_at < ?' : ''}
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(...(q.before ? [q.sessionId, q.before, limit] : [q.sessionId, limit])) as Array<{
    message_id: string;
    session_id: string;
    adapter: string;
    party: string;
    content: string;
    meta_json: string;
    files_json: string;
    ts: string;
    state: string;
  }>;

  const merged: TranscriptMessage[] = [
    ...inbound.map((r) => ({
      messageId: r.message_id,
      direction: 'inbound' as const,
      sessionId: r.session_id,
      adapter: r.adapter,
      party: r.party,
      content: r.content,
      meta: safeJson<Record<string, string>>(r.meta_json, {}),
      files: safeJson<string[]>(r.files_json, []),
      timestamp: r.ts,
      state: r.state,
    })),
    ...outbound.map((r) => ({
      messageId: r.message_id,
      direction: 'outbound' as const,
      sessionId: r.session_id,
      adapter: r.adapter,
      party: r.party,
      content: r.content,
      meta: safeJson<Record<string, string>>(r.meta_json, {}),
      files: safeJson<string[]>(r.files_json, []),
      timestamp: r.ts,
      state: r.state,
    })),
  ];
  merged.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return merged.slice(0, limit);
}

export interface SessionActivity {
  sessionId: string;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
}

export function getSessionActivity(db: Db, sessionId: string): SessionActivity {
  const inbound = db
    .prepare(
      `SELECT received_at AS ts FROM inbound_messages WHERE session_id = ? ORDER BY received_at DESC LIMIT 1`,
    )
    .get(sessionId) as { ts: string } | undefined;
  const outbound = db
    .prepare(
      `SELECT created_at AS ts FROM outbound_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sessionId) as { ts: string } | undefined;
  return {
    sessionId,
    lastInboundAt: inbound?.ts ?? null,
    lastOutboundAt: outbound?.ts ?? null,
  };
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
