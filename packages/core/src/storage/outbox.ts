import { randomUUID } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';

export interface InboundInsert {
  session_id: string;
  adapter: string;
  sender_id: string;
  content: string;
  meta: Record<string, string>;
  files: readonly string[];
  correlation_id?: string;
  idempotency_key?: string;
}

export interface InboundInsertResult {
  message_id: string;
  inserted: boolean;
}

export interface InboundRow {
  message_id: string;
  session_id: string;
  adapter: string;
  sender_id: string;
  correlation_id: string | null;
  content: string;
  meta: Record<string, string>;
  files: readonly string[];
  received_at: string;
  state: 'received' | 'delivered' | 'acknowledged' | 'failed';
}

export function insertInbound(db: Db, msg: InboundInsert): InboundInsertResult {
  if (msg.idempotency_key) {
    const existing = db
      .prepare(
        'SELECT message_id FROM inbound_messages WHERE adapter = ? AND idempotency_key = ?',
      )
      .get(msg.adapter, msg.idempotency_key) as { message_id: string } | undefined;
    if (existing) {
      return { message_id: existing.message_id, inserted: false };
    }
  }

  const message_id = randomUUID();
  db.prepare(
    `INSERT INTO inbound_messages
       (message_id, session_id, adapter, sender_id, correlation_id,
        content, meta_json, files_json, idempotency_key, received_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received')`,
  ).run(
    message_id,
    msg.session_id,
    msg.adapter,
    msg.sender_id,
    msg.correlation_id ?? null,
    msg.content,
    JSON.stringify(msg.meta),
    JSON.stringify(msg.files),
    msg.idempotency_key ?? null,
    new Date().toISOString(),
  );
  return { message_id, inserted: true };
}

export function markInboundDelivered(db: Db, messageId: string): void {
  db.prepare(
    `UPDATE inbound_messages
       SET state = 'delivered', delivered_at = ?
     WHERE message_id = ? AND state = 'received'`,
  ).run(new Date().toISOString(), messageId);
}

export function markInboundAcknowledged(db: Db, messageId: string): void {
  db.prepare(
    `UPDATE inbound_messages
       SET state = 'acknowledged', acknowledged_at = ?, delivered_at = COALESCE(delivered_at, ?)
     WHERE message_id = ? AND state IN ('received', 'delivered')`,
  ).run(new Date().toISOString(), new Date().toISOString(), messageId);
}

export function markInboundFailed(db: Db, messageId: string, error: string): void {
  db.prepare(
    `UPDATE inbound_messages
       SET state = 'failed'
     WHERE message_id = ?`,
  ).run(messageId);
  // (error column not present for inbound; logged separately)
  void error;
}

function rowToInbound(row: {
  message_id: string;
  session_id: string;
  adapter: string;
  sender_id: string;
  correlation_id: string | null;
  content: string;
  meta_json: string;
  files_json: string;
  received_at: string;
  state: string;
}): InboundRow {
  return {
    message_id: row.message_id,
    session_id: row.session_id,
    adapter: row.adapter,
    sender_id: row.sender_id,
    correlation_id: row.correlation_id,
    content: row.content,
    meta: JSON.parse(row.meta_json) as Record<string, string>,
    files: JSON.parse(row.files_json) as string[],
    received_at: row.received_at,
    state: row.state as InboundRow['state'],
  };
}

export function listPendingInboundForSession(db: Db, sessionId: string): InboundRow[] {
  const rows = db
    .prepare(
      `SELECT message_id, session_id, adapter, sender_id, correlation_id,
              content, meta_json, files_json, received_at, state
         FROM inbound_messages
        WHERE session_id = ? AND state IN ('received', 'delivered')
        ORDER BY received_at, rowid`,
    )
    .all(sessionId) as Array<Parameters<typeof rowToInbound>[0]>;
  return rows.map(rowToInbound);
}

// -----------------------------------------------------------------------------
// Outbound
// -----------------------------------------------------------------------------

export interface OutboundInsert {
  message_id: string;
  session_id: string;
  adapter: string;
  recipient: string;
  content: string;
  meta: Record<string, string>;
  files: readonly string[];
  correlation_id?: string;
}

export interface OutboundRow {
  message_id: string;
  session_id: string;
  adapter: string;
  recipient: string;
  correlation_id: string | null;
  content: string;
  meta: Record<string, string>;
  files: readonly string[];
  created_at: string;
  state: 'pending' | 'sent' | 'failed' | 'expired';
  attempt_count: number;
  last_error: string | null;
}

export function insertOutbound(db: Db, msg: OutboundInsert): void {
  db.prepare(
    `INSERT INTO outbound_messages
       (message_id, session_id, adapter, recipient, correlation_id,
        content, meta_json, files_json, created_at, state, attempt_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
  ).run(
    msg.message_id,
    msg.session_id,
    msg.adapter,
    msg.recipient,
    msg.correlation_id ?? null,
    msg.content,
    JSON.stringify(msg.meta),
    JSON.stringify(msg.files),
    new Date().toISOString(),
  );
}

export function markOutboundSent(db: Db, messageId: string, transportMsgId?: string): void {
  db.prepare(
    `UPDATE outbound_messages
       SET state = 'sent', sent_at = ?, transport_msg_id = ?
     WHERE message_id = ? AND state = 'pending'`,
  ).run(new Date().toISOString(), transportMsgId ?? null, messageId);
}

export function markOutboundFailed(db: Db, messageId: string, error: string): void {
  db.prepare(
    `UPDATE outbound_messages
       SET state = 'failed', last_error = ?
     WHERE message_id = ?`,
  ).run(error, messageId);
}

export function incrementOutboundAttempt(db: Db, messageId: string): void {
  db.prepare('UPDATE outbound_messages SET attempt_count = attempt_count + 1 WHERE message_id = ?').run(messageId);
}

function rowToOutbound(row: {
  message_id: string;
  session_id: string;
  adapter: string;
  recipient: string;
  correlation_id: string | null;
  content: string;
  meta_json: string;
  files_json: string;
  created_at: string;
  state: string;
  attempt_count: number;
  last_error: string | null;
}): OutboundRow {
  return {
    message_id: row.message_id,
    session_id: row.session_id,
    adapter: row.adapter,
    recipient: row.recipient,
    correlation_id: row.correlation_id,
    content: row.content,
    meta: JSON.parse(row.meta_json) as Record<string, string>,
    files: JSON.parse(row.files_json) as string[],
    created_at: row.created_at,
    state: row.state as OutboundRow['state'],
    attempt_count: row.attempt_count,
    last_error: row.last_error,
  };
}

export function listPendingOutbound(db: Db, adapter: string, limit: number): OutboundRow[] {
  const rows = db
    .prepare(
      `SELECT message_id, session_id, adapter, recipient, correlation_id,
              content, meta_json, files_json, created_at, state, attempt_count, last_error
         FROM outbound_messages
        WHERE adapter = ? AND state = 'pending'
        ORDER BY created_at, rowid
        LIMIT ?`,
    )
    .all(adapter, limit) as Array<Parameters<typeof rowToOutbound>[0]>;
  return rows.map(rowToOutbound);
}
