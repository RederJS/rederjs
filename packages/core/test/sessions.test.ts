import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DatabaseHandle } from '../src/storage/db.js';
import {
  createSession,
  verifyToken,
  markConnected,
  markDisconnected,
  revokeSession,
  getSessionState,
} from '../src/sessions.js';

let dir: string;
let db: DatabaseHandle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reder-sess-test-'));
  db = openDatabase(join(dir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('session registry', () => {
  it('creates a session and returns a random token with rdr_sess_ prefix', async () => {
    const result = await createSession(db.raw, 'booknerds', 'BookNerds');
    expect(result.created).toBe(true);
    expect(result.token).toMatch(/^rdr_sess_[A-Za-z0-9_-]{43,}$/);
  });

  it('verifies a token that matches', async () => {
    const { token } = await createSession(db.raw, 'booknerds', 'BookNerds');
    const ok = await verifyToken(db.raw, 'booknerds', token);
    expect(ok).toBe(true);
  });

  it('rejects a token that does not match', async () => {
    await createSession(db.raw, 'booknerds', 'BookNerds');
    const ok = await verifyToken(db.raw, 'booknerds', 'rdr_sess_wrong');
    expect(ok).toBe(false);
  });

  it('returns false for unknown session_id', async () => {
    const ok = await verifyToken(db.raw, 'nope', 'rdr_sess_anything');
    expect(ok).toBe(false);
  });

  it('re-registering an existing session rotates the token and returns created=false', async () => {
    const first = await createSession(db.raw, 'booknerds', 'BookNerds');
    const second = await createSession(db.raw, 'booknerds', 'BookNerds');
    expect(second.created).toBe(false);
    expect(second.token).not.toBe(first.token);
    const oldOk = await verifyToken(db.raw, 'booknerds', first.token);
    const newOk = await verifyToken(db.raw, 'booknerds', second.token);
    expect(oldOk).toBe(false);
    expect(newOk).toBe(true);
  });

  it('markConnected sets state and last_seen_at', async () => {
    await createSession(db.raw, 'x', 'X');
    markConnected(db.raw, 'x');
    const state = getSessionState(db.raw, 'x');
    expect(state?.state).toBe('connected');
    expect(state?.last_seen_at).toBeTruthy();
  });

  it('markDisconnected sets state to disconnected', async () => {
    await createSession(db.raw, 'x', 'X');
    markConnected(db.raw, 'x');
    markDisconnected(db.raw, 'x');
    expect(getSessionState(db.raw, 'x')?.state).toBe('disconnected');
  });

  it('revokeSession sets state to revoked and verifyToken fails', async () => {
    const { token } = await createSession(db.raw, 'x', 'X');
    revokeSession(db.raw, 'x');
    expect(getSessionState(db.raw, 'x')?.state).toBe('revoked');
    expect(await verifyToken(db.raw, 'x', token)).toBe(false);
  });
});
