import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { Database as Db } from 'better-sqlite3';

const TOKEN_PREFIX = 'rdr_sess_';
const TOKEN_ENTROPY_BYTES = 32;

// Argon2id parameters. OWASP Password Storage Cheat Sheet (2024) documents
// m=46 MiB, t=1, p=1 as the minimum for argon2id. The `argon2` npm library
// enforces its own minimum of t>=2, so we use t=2 (above OWASP on time) and
// m=46 MiB (matching OWASP on memory). Brute-force is already infeasible for
// our 32-byte random tokens; this just matches the cheat-sheet floor and
// pre-empts review-comment churn during open-source security audits.
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 47104, // 46 MiB (47104 KiB)
  timeCost: 2,
  parallelism: 1,
};

export interface CreateSessionResult {
  token: string;
  created: boolean;
}

export interface SessionState {
  session_id: string;
  display_name: string;
  state: 'registered' | 'connected' | 'disconnected' | 'revoked';
  created_at: string;
  last_seen_at: string | null;
  claude_summary: string | null;
}

function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url');
}

export async function createSession(
  db: Db,
  sessionId: string,
  displayName: string,
): Promise<CreateSessionResult> {
  const token = generateToken();
  const hash = await argon2.hash(token, ARGON2_OPTIONS);
  const existing = db
    .prepare('SELECT session_id FROM sessions WHERE session_id = ?')
    .get(sessionId);

  if (existing) {
    db.prepare(
      `UPDATE sessions
         SET shim_token_hash = ?, display_name = ?, state = 'registered'
       WHERE session_id = ?`,
    ).run(hash, displayName, sessionId);
    return { token, created: false };
  }

  db.prepare(
    `INSERT INTO sessions (session_id, display_name, shim_token_hash, created_at, state)
     VALUES (?, ?, ?, ?, 'registered')`,
  ).run(sessionId, displayName, hash, new Date().toISOString());

  return { token, created: true };
}

export async function verifyToken(db: Db, sessionId: string, token: string): Promise<boolean> {
  const row = db
    .prepare('SELECT shim_token_hash, state FROM sessions WHERE session_id = ?')
    .get(sessionId) as { shim_token_hash: string; state: string } | undefined;

  if (!row) return false;
  if (row.state === 'revoked') return false;

  try {
    return await argon2.verify(row.shim_token_hash, token);
  } catch {
    return false;
  }
}

export function markConnected(db: Db, sessionId: string): void {
  db.prepare(`UPDATE sessions SET state = 'connected', last_seen_at = ? WHERE session_id = ?`).run(
    new Date().toISOString(),
    sessionId,
  );
}

export function markDisconnected(db: Db, sessionId: string): void {
  db.prepare(
    `UPDATE sessions SET state = 'disconnected', last_seen_at = ? WHERE session_id = ?`,
  ).run(new Date().toISOString(), sessionId);
}

export function revokeSession(db: Db, sessionId: string): void {
  db.prepare(`UPDATE sessions SET state = 'revoked' WHERE session_id = ?`).run(sessionId);
}

export interface DeleteSessionResult {
  deleted: boolean;
  bindings_removed: number;
}

/**
 * Remove a session row and any rows that FK-reference it (bindings).
 * Other session-scoped tables (messages, permissions, approvals) don't have
 * foreign-key constraints; those rows remain and are harmless — flag as tech
 * debt if this becomes a real issue.
 */
export function deleteSession(db: Db, sessionId: string): DeleteSessionResult {
  const tx = db.transaction(() => {
    const bindings = db.prepare('DELETE FROM bindings WHERE session_id = ?').run(sessionId);
    const session = db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
    return { deleted: session.changes > 0, bindings_removed: bindings.changes };
  });
  return tx();
}

export function getSessionState(db: Db, sessionId: string): SessionState | null {
  const row = db
    .prepare(
      `SELECT session_id, display_name, state, created_at, last_seen_at, claude_summary
         FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId) as SessionState | undefined;
  return row ?? null;
}

export function listSessions(db: Db): SessionState[] {
  return db
    .prepare(
      `SELECT session_id, display_name, state, created_at, last_seen_at, claude_summary
         FROM sessions ORDER BY created_at`,
    )
    .all() as SessionState[];
}
