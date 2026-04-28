import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, type DatabaseHandle } from '../../src/storage/db.js';
import { createSession } from '../../src/sessions.js';
import { insertInbound, insertOutbound } from '../../src/storage/outbox.js';
import { purgeSessionData } from '../../src/storage/purge.js';

let dir: string;
let db: DatabaseHandle;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-purge-test-'));
  db = openDatabase(join(dir, 'test.db'));
  await createSession(db.raw, 'sess-a', 'A');
  await createSession(db.raw, 'sess-b', 'B');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedPermission(sessionId: string, requestId: string): void {
  db.raw
    .prepare(
      `INSERT INTO permission_requests
         (request_id, session_id, tool_name, tool_input, description, created_at, expires_at)
       VALUES (?, ?, 'Bash', '{}', '', ?, ?)`,
    )
    .run(
      requestId,
      sessionId,
      new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
    );
}

function seedTranscriptOffset(sessionId: string, path: string, offset: number): void {
  db.raw
    .prepare(
      `INSERT INTO transcript_offsets (session_id, transcript_path, byte_offset, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(sessionId, path, offset, new Date().toISOString());
}

describe('purgeSessionData', () => {
  it('deletes inbound, outbound, permissions, and transcript offsets for the target session only', () => {
    insertInbound(db.raw, {
      session_id: 'sess-a',
      adapter: 'telegram',
      sender_id: '1',
      content: 'hello A',
      meta: {},
      files: [],
    });
    insertInbound(db.raw, {
      session_id: 'sess-b',
      adapter: 'telegram',
      sender_id: '1',
      content: 'hello B',
      meta: {},
      files: [],
    });
    insertOutbound(db.raw, {
      message_id: randomUUID(),
      session_id: 'sess-a',
      adapter: 'telegram',
      recipient: '1',
      content: 'reply A',
      meta: {},
      files: [],
    });
    insertOutbound(db.raw, {
      message_id: randomUUID(),
      session_id: 'sess-b',
      adapter: 'telegram',
      recipient: '1',
      content: 'reply B',
      meta: {},
      files: [],
    });
    seedPermission('sess-a', 'req-a-1');
    seedPermission('sess-a', 'req-a-2');
    seedPermission('sess-b', 'req-b-1');
    seedTranscriptOffset('sess-a', '/tmp/a.jsonl', 1234);
    seedTranscriptOffset('sess-b', '/tmp/b.jsonl', 5678);

    const result = purgeSessionData(db.raw, 'sess-a');

    expect(result).toEqual({
      inbound: 1,
      outbound: 1,
      permissions: 2,
      transcriptOffsets: 1,
    });

    const inboundB = db.raw
      .prepare('SELECT COUNT(*) AS c FROM inbound_messages WHERE session_id = ?')
      .get('sess-b') as { c: number };
    expect(inboundB.c).toBe(1);

    const outboundB = db.raw
      .prepare('SELECT COUNT(*) AS c FROM outbound_messages WHERE session_id = ?')
      .get('sess-b') as { c: number };
    expect(outboundB.c).toBe(1);

    const permsB = db.raw
      .prepare('SELECT COUNT(*) AS c FROM permission_requests WHERE session_id = ?')
      .get('sess-b') as { c: number };
    expect(permsB.c).toBe(1);

    const offsetB = db.raw
      .prepare('SELECT COUNT(*) AS c FROM transcript_offsets WHERE session_id = ?')
      .get('sess-b') as { c: number };
    expect(offsetB.c).toBe(1);

    const sessionRowA = db.raw
      .prepare('SELECT session_id FROM sessions WHERE session_id = ?')
      .get('sess-a');
    expect(sessionRowA).toBeDefined();
  });

  it('returns zeros for an unknown session and does not error', () => {
    const result = purgeSessionData(db.raw, 'does-not-exist');
    expect(result).toEqual({
      inbound: 0,
      outbound: 0,
      permissions: 0,
      transcriptOffsets: 0,
    });
  });

  it('preserves persistent_approvals and bindings', () => {
    db.raw
      .prepare(
        `INSERT INTO persistent_approvals
           (approval_id, session_id, tool_name, input_signature, created_at, respondent)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), 'sess-a', 'Bash', 'sig', new Date().toISOString(), 'user');
    db.raw
      .prepare(
        `INSERT INTO bindings (binding_id, session_id, adapter, sender_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), 'sess-a', 'telegram', '99', new Date().toISOString());

    purgeSessionData(db.raw, 'sess-a');

    const approvals = db.raw
      .prepare('SELECT COUNT(*) AS c FROM persistent_approvals WHERE session_id = ?')
      .get('sess-a') as { c: number };
    expect(approvals.c).toBe(1);

    const bindings = db.raw
      .prepare('SELECT COUNT(*) AS c FROM bindings WHERE session_id = ?')
      .get('sess-a') as { c: number };
    expect(bindings.c).toBe(1);
  });
});
