import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';

/**
 * 6-char alphabet: lowercase a-z minus 'l' and digits 2-9 (no 0/1 to avoid l/o/i confusion).
 * 34 chars → 34^6 ≈ 1.5B codes. Plenty.
 */
const CODE_ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789';
const CODE_LENGTH = 6;
const CODE_TTL_MS = 10 * 60 * 1000;
const ID_BYTES = 16;
const SALT_BYTES = 16;

export function generatePairCode(): string {
  const bytes = randomBytes(CODE_LENGTH * 2);
  let out = '';
  for (let i = 0; out.length < CODE_LENGTH && i < bytes.length; i++) {
    const c = CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    if (c) out += c;
  }
  return out;
}

function hashCode(code: string, salt: Buffer): Buffer {
  const h = createHash('sha256');
  h.update(code, 'utf8');
  h.update(salt);
  return h.digest();
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

/**
 * Generate a fresh pair code, store its salted SHA-256 hash, and return the
 * plaintext code to the caller (the only place it ever exists in memory).
 */
export function createPairCode(db: Db, input: CreatePairCodeInput): PairCodeRecord {
  const code = generatePairCode();
  const id = randomBytes(ID_BYTES);
  const salt = randomBytes(SALT_BYTES);
  const codeHash = hashCode(code, salt);
  const created_at = new Date();
  const expires_at = new Date(created_at.getTime() + CODE_TTL_MS);
  db.prepare(
    `INSERT INTO pair_codes_v2
       (id, code_hash, salt, adapter, sender_id, sender_metadata, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    codeHash,
    salt,
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

interface PairCodeRow {
  id: Buffer;
  code_hash: Buffer;
  salt: Buffer;
  adapter: string;
  sender_id: string;
  sender_metadata: string | null;
  expires_at: string;
}

interface ActiveRow {
  id: Buffer;
  adapter: string;
  senderId: string;
  senderMetadata: Record<string, unknown> | null;
  expiresAt: string;
}

function findActiveRow(db: Db, code: string): ActiveRow | null {
  const rows = db
    .prepare(
      `SELECT id, code_hash, salt, adapter, sender_id, sender_metadata, expires_at
         FROM pair_codes_v2
        WHERE expires_at > ?`,
    )
    .all(new Date().toISOString()) as PairCodeRow[];
  for (const row of rows) {
    const candidate = hashCode(code, row.salt);
    if (candidate.length === row.code_hash.length && timingSafeEqual(candidate, row.code_hash)) {
      return {
        id: row.id,
        adapter: row.adapter,
        senderId: row.sender_id,
        senderMetadata: row.sender_metadata
          ? (JSON.parse(row.sender_metadata) as Record<string, unknown>)
          : null,
        expiresAt: row.expires_at,
      };
    }
  }
  return null;
}

/**
 * Look up a pair code by plaintext. Iterates non-expired rows, comparing each
 * stored hash with `timingSafeEqual` against `sha256(code || salt)`. Returns
 * the metadata of the matching row (without exposing the row id). This is a
 * read-only operation suitable for inspection; redemption must go through
 * {@link redeemPairCode} so that the lookup-then-delete pair is atomic.
 */
export function lookupPairCode(db: Db, code: string): PairCodeRecord | null {
  const row = findActiveRow(db, code);
  if (!row) return null;
  return {
    code,
    adapter: row.adapter,
    senderId: row.senderId,
    senderMetadata: row.senderMetadata,
    expiresAt: row.expiresAt,
  };
}

export interface RedeemedPairCode {
  adapter: string;
  senderId: string;
  senderMetadata: Record<string, unknown> | null;
  expiresAt: string;
}

/**
 * Atomically look up and consume a pair code. Runs in a single SQLite
 * transaction so that concurrent redemption attempts can never both succeed:
 * the second `DELETE … WHERE id = ? AND expires_at > ?` will report
 * `changes === 0` and the caller is told the code is invalid.
 *
 * Returns the redeemed binding metadata on success, `null` if no live code
 * matched, or if another caller consumed it first.
 */
export function redeemPairCode(db: Db, code: string): RedeemedPairCode | null {
  const txn = db.transaction((): RedeemedPairCode | null => {
    const row = findActiveRow(db, code);
    if (!row) return null;
    const nowIso = new Date().toISOString();
    const result = db
      .prepare('DELETE FROM pair_codes_v2 WHERE id = ? AND expires_at > ?')
      .run(row.id, nowIso);
    if (result.changes !== 1) return null;
    return {
      adapter: row.adapter,
      senderId: row.senderId,
      senderMetadata: row.senderMetadata,
      expiresAt: row.expiresAt,
    };
  });
  return txn();
}

/**
 * Delete every row from `pair_codes_v2` (useful when a redemption attempt was
 * already paired — keep callers from leaking the row). Exposed for tests; the
 * router uses {@link redeemPairCode} in the normal path.
 */
export function consumePairCodeById(db: Db, id: Buffer): void {
  db.prepare('DELETE FROM pair_codes_v2 WHERE id = ?').run(id);
}

export function purgeExpiredPairCodes(db: Db): number {
  const result = db
    .prepare('DELETE FROM pair_codes_v2 WHERE expires_at < ?')
    .run(new Date().toISOString());
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
  params: {
    sessionId: string;
    adapter: string;
    senderId: string;
    metadata?: Record<string, unknown>;
  },
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
  params: {
    sessionId: string;
    adapter: string;
    senderId: string;
    metadata?: Record<string, unknown>;
  },
): Binding {
  const existing = getBinding(db, params.adapter, params.senderId, params.sessionId);
  if (existing) {
    if (params.metadata !== undefined) {
      db.prepare(
        `UPDATE bindings SET metadata = ?
           WHERE adapter = ? AND sender_id = ? AND session_id = ?`,
      ).run(JSON.stringify(params.metadata), params.adapter, params.senderId, params.sessionId);
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
    | {
        binding_id: string;
        session_id: string;
        adapter: string;
        sender_id: string;
        created_at: string;
        metadata: string | null;
      }
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

export function isPaired(db: Db, adapter: string, senderId: string, sessionId: string): boolean {
  return getBinding(db, adapter, senderId, sessionId) !== null;
}

export function listAllBindingsForSession(db: Db, sessionId: string): Binding[] {
  const rows = db
    .prepare(
      `SELECT binding_id, session_id, adapter, sender_id, created_at, metadata
         FROM bindings WHERE session_id = ?
         ORDER BY adapter, created_at, binding_id`,
    )
    .all(sessionId) as Array<{
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

/**
 * Delete every binding for `(adapter, sessionId)` whose `sender_id` is NOT in
 * `allowedSenderIds`. Returns the count of rows deleted. Used by adapters
 * running in allowlist mode to reconcile persisted bindings against the
 * current allowlist on startup — a sender removed from the allowlist must not
 * be able to resolve outstanding bindings (e.g. permission-prompt callbacks).
 *
 * If `allowedSenderIds` is empty, deletes every binding for `(adapter,
 * sessionId)`.
 */
export function deleteBindingsForSessionExceptSenders(
  db: Db,
  params: { adapter: string; sessionId: string; allowedSenderIds: readonly string[] },
): number {
  if (params.allowedSenderIds.length === 0) {
    const result = db
      .prepare(`DELETE FROM bindings WHERE adapter = ? AND session_id = ?`)
      .run(params.adapter, params.sessionId);
    return Number(result.changes);
  }
  const placeholders = params.allowedSenderIds.map(() => '?').join(', ');
  const result = db
    .prepare(
      `DELETE FROM bindings
         WHERE adapter = ? AND session_id = ?
           AND sender_id NOT IN (${placeholders})`,
    )
    .run(params.adapter, params.sessionId, ...params.allowedSenderIds);
  return Number(result.changes);
}
