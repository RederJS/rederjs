import { randomBytes, randomUUID } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';

/**
 * 6-char alphabet: lowercase a-z minus 'l' and digits 2-9 (no 0/1 to avoid l/o/i confusion).
 * 34 chars → 34^6 ≈ 1.5B codes. Plenty.
 */
const CODE_ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789';
const CODE_LENGTH = 6;
const CODE_TTL_MS = 10 * 60 * 1000;

export function generatePairCode(): string {
  const bytes = randomBytes(CODE_LENGTH * 2);
  let out = '';
  for (let i = 0; out.length < CODE_LENGTH && i < bytes.length; i++) {
    const c = CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    if (c) out += c;
  }
  return out;
}

export interface CreatePairCodeInput {
  adapter: string;
  senderId: string;
  senderMetadata?: Record<string, unknown>;
}

export interface PairCodeRecord {
  code: string;
  adapter: string;
  senderId: string;
  senderMetadata: Record<string, unknown> | null;
  expiresAt: string;
}

export function createPairCode(db: Db, input: CreatePairCodeInput): PairCodeRecord {
  const code = generatePairCode();
  const created_at = new Date();
  const expires_at = new Date(created_at.getTime() + CODE_TTL_MS);
  db.prepare(
    `INSERT INTO pair_codes (code, adapter, sender_id, sender_metadata, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    code,
    input.adapter,
    input.senderId,
    input.senderMetadata ? JSON.stringify(input.senderMetadata) : null,
    created_at.toISOString(),
    expires_at.toISOString(),
  );
  return {
    code,
    adapter: input.adapter,
    senderId: input.senderId,
    senderMetadata: input.senderMetadata ?? null,
    expiresAt: expires_at.toISOString(),
  };
}

export function lookupPairCode(db: Db, code: string): PairCodeRecord | null {
  const row = db
    .prepare(
      'SELECT code, adapter, sender_id, sender_metadata, expires_at FROM pair_codes WHERE code = ?',
    )
    .get(code) as
    | { code: string; adapter: string; sender_id: string; sender_metadata: string | null; expires_at: string }
    | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return {
    code: row.code,
    adapter: row.adapter,
    senderId: row.sender_id,
    senderMetadata: row.sender_metadata ? (JSON.parse(row.sender_metadata) as Record<string, unknown>) : null,
    expiresAt: row.expires_at,
  };
}

export function consumePairCode(db: Db, code: string): void {
  db.prepare('DELETE FROM pair_codes WHERE code = ?').run(code);
}

export function purgeExpiredPairCodes(db: Db): number {
  const result = db.prepare('DELETE FROM pair_codes WHERE expires_at < ?').run(new Date().toISOString());
  return Number(result.changes);
}

// -----------------------------------------------------------------------------
// Bindings
// -----------------------------------------------------------------------------

export interface Binding {
  bindingId: string;
  sessionId: string;
  adapter: string;
  senderId: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

export function createBinding(
  db: Db,
  params: { sessionId: string; adapter: string; senderId: string; metadata?: Record<string, unknown> },
): Binding {
  const bindingId = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO bindings (binding_id, session_id, adapter, sender_id, created_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    bindingId,
    params.sessionId,
    params.adapter,
    params.senderId,
    createdAt,
    params.metadata ? JSON.stringify(params.metadata) : null,
  );
  const existing = getBinding(db, params.adapter, params.senderId, params.sessionId);
  if (!existing) {
    throw new Error('failed to create binding');
  }
  return existing;
}

/**
 * Insert a binding if missing; otherwise refresh its metadata. Used when an
 * adapter wants to pre-approve a sender without a pair-code exchange (e.g.
 * global allowlist mode) and needs the binding row in place so outbound
 * routing and permission-prompt delivery can find the chat.
 */
export function upsertBinding(
  db: Db,
  params: { sessionId: string; adapter: string; senderId: string; metadata?: Record<string, unknown> },
): Binding {
  const existing = getBinding(db, params.adapter, params.senderId, params.sessionId);
  if (existing) {
    if (params.metadata !== undefined) {
      db.prepare(
        `UPDATE bindings SET metadata = ?
           WHERE adapter = ? AND sender_id = ? AND session_id = ?`,
      ).run(
        JSON.stringify(params.metadata),
        params.adapter,
        params.senderId,
        params.sessionId,
      );
      return {
        ...existing,
        metadata: params.metadata,
      };
    }
    return existing;
  }
  return createBinding(db, params);
}

export function getBinding(
  db: Db,
  adapter: string,
  senderId: string,
  sessionId: string,
): Binding | null {
  const row = db
    .prepare(
      `SELECT binding_id, session_id, adapter, sender_id, created_at, metadata
         FROM bindings
        WHERE adapter = ? AND sender_id = ? AND session_id = ?`,
    )
    .get(adapter, senderId, sessionId) as
    | { binding_id: string; session_id: string; adapter: string; sender_id: string; created_at: string; metadata: string | null }
    | undefined;
  if (!row) return null;
  return {
    bindingId: row.binding_id,
    sessionId: row.session_id,
    adapter: row.adapter,
    senderId: row.sender_id,
    createdAt: row.created_at,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
  };
}

export function isPaired(
  db: Db,
  adapter: string,
  senderId: string,
  sessionId: string,
): boolean {
  return getBinding(db, adapter, senderId, sessionId) !== null;
}

export function listBindingsForSender(db: Db, adapter: string, senderId: string): Binding[] {
  const rows = db
    .prepare(
      `SELECT binding_id, session_id, adapter, sender_id, created_at, metadata
         FROM bindings WHERE adapter = ? AND sender_id = ?`,
    )
    .all(adapter, senderId) as Array<{
    binding_id: string;
    session_id: string;
    adapter: string;
    sender_id: string;
    created_at: string;
    metadata: string | null;
  }>;
  return rows.map((r) => ({
    bindingId: r.binding_id,
    sessionId: r.session_id,
    adapter: r.adapter,
    senderId: r.sender_id,
    createdAt: r.created_at,
    metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
  }));
}
