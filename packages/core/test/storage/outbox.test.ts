import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, type DatabaseHandle } from '../../src/storage/db.js';
import { createSession } from '../../src/sessions.js';
import {
  insertInbound,
  markInboundDelivered,
  markInboundAcknowledged,
  markInboundFailed,
  listPendingInboundForSession,
  insertOutbound,
  markOutboundSent,
  markOutboundFailed,
  incrementOutboundAttempt,
  listPendingOutbound,
} from '../../src/storage/outbox.js';

let dir: string;
let db: DatabaseHandle;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reder-outbox-test-'));
  db = openDatabase(join(dir, 'test.db'));
  await createSession(db.raw, 'sess', 'Sess');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('inbound outbox', () => {
  it('inserts a row in state received and returns message_id + inserted=true', () => {
    const r = insertInbound(db.raw, {
      session_id: 'sess',
      adapter: 'telegram',
      sender_id: '1234',
      content: 'hello',
      meta: { chat_id: '1' },
      files: [],
    });
    expect(r.inserted).toBe(true);
    expect(r.message_id).toBeTruthy();
  });

  it('is idempotent when idempotency_key is supplied', () => {
    const key = 'telegram:chat:1:msg:42';
    const first = insertInbound(db.raw, {
      session_id: 'sess',
      adapter: 'telegram',
      sender_id: '1',
      content: 'a',
      meta: {},
      files: [],
      idempotency_key: key,
    });
    const second = insertInbound(db.raw, {
      session_id: 'sess',
      adapter: 'telegram',
      sender_id: '1',
      content: 'a',
      meta: {},
      files: [],
      idempotency_key: key,
    });
    expect(second.inserted).toBe(false);
    expect(second.message_id).toBe(first.message_id);
  });

  it('transitions received → delivered → acknowledged', () => {
    const { message_id } = insertInbound(db.raw, {
      session_id: 'sess',
      adapter: 't',
      sender_id: '1',
      content: 'x',
      meta: {},
      files: [],
    });
    markInboundDelivered(db.raw, message_id);
    markInboundAcknowledged(db.raw, message_id);
    const row = db.raw
      .prepare(
        'SELECT state, delivered_at, acknowledged_at FROM inbound_messages WHERE message_id = ?',
      )
      .get(message_id) as { state: string; delivered_at: string; acknowledged_at: string };
    expect(row.state).toBe('acknowledged');
    expect(row.delivered_at).toBeTruthy();
    expect(row.acknowledged_at).toBeTruthy();
  });

  it('transitions to failed terminal state', () => {
    const { message_id } = insertInbound(db.raw, {
      session_id: 'sess',
      adapter: 't',
      sender_id: '1',
      content: 'x',
      meta: {},
      files: [],
    });
    markInboundFailed(db.raw, message_id, 'boom');
    const row = db.raw
      .prepare('SELECT state FROM inbound_messages WHERE message_id = ?')
      .get(message_id) as { state: string };
    expect(row.state).toBe('failed');
  });

  it('listPendingInboundForSession returns non-acknowledged rows in received_at order', () => {
    const a = insertInbound(db.raw, {
      session_id: 'sess',
      adapter: 't',
      sender_id: '1',
      content: 'a',
      meta: {},
      files: [],
    });
    const b = insertInbound(db.raw, {
      session_id: 'sess',
      adapter: 't',
      sender_id: '1',
      content: 'b',
      meta: {},
      files: [],
    });
    const c = insertInbound(db.raw, {
      session_id: 'sess',
      adapter: 't',
      sender_id: '1',
      content: 'c',
      meta: {},
      files: [],
    });
    markInboundAcknowledged(db.raw, b.message_id);
    const pending = listPendingInboundForSession(db.raw, 'sess');
    expect(pending.map((r) => r.message_id)).toEqual([a.message_id, c.message_id]);
  });
});

describe('outbound outbox', () => {
  it('inserts in state pending with attempt_count=0', () => {
    const msgId = randomUUID();
    insertOutbound(db.raw, {
      message_id: msgId,
      session_id: 'sess',
      adapter: 'telegram',
      recipient: '42',
      content: 'hi',
      meta: {},
      files: [],
    });
    const row = db.raw
      .prepare('SELECT state, attempt_count FROM outbound_messages WHERE message_id = ?')
      .get(msgId) as { state: string; attempt_count: number };
    expect(row.state).toBe('pending');
    expect(row.attempt_count).toBe(0);
  });

  it('markOutboundSent records transport_msg_id and sent_at', () => {
    const msgId = randomUUID();
    insertOutbound(db.raw, {
      message_id: msgId,
      session_id: 'sess',
      adapter: 't',
      recipient: '1',
      content: 'x',
      meta: {},
      files: [],
    });
    markOutboundSent(db.raw, msgId, 'tg-789');
    const row = db.raw
      .prepare(
        'SELECT state, transport_msg_id, sent_at FROM outbound_messages WHERE message_id = ?',
      )
      .get(msgId) as { state: string; transport_msg_id: string; sent_at: string };
    expect(row.state).toBe('sent');
    expect(row.transport_msg_id).toBe('tg-789');
    expect(row.sent_at).toBeTruthy();
  });

  it('markOutboundFailed stores last_error', () => {
    const msgId = randomUUID();
    insertOutbound(db.raw, {
      message_id: msgId,
      session_id: 'sess',
      adapter: 't',
      recipient: '1',
      content: 'x',
      meta: {},
      files: [],
    });
    markOutboundFailed(db.raw, msgId, 'rate limited');
    const row = db.raw
      .prepare('SELECT state, last_error FROM outbound_messages WHERE message_id = ?')
      .get(msgId) as { state: string; last_error: string };
    expect(row.state).toBe('failed');
    expect(row.last_error).toBe('rate limited');
  });

  it('incrementOutboundAttempt bumps attempt_count', () => {
    const msgId = randomUUID();
    insertOutbound(db.raw, {
      message_id: msgId,
      session_id: 'sess',
      adapter: 't',
      recipient: '1',
      content: 'x',
      meta: {},
      files: [],
    });
    incrementOutboundAttempt(db.raw, msgId);
    incrementOutboundAttempt(db.raw, msgId);
    const row = db.raw
      .prepare('SELECT attempt_count FROM outbound_messages WHERE message_id = ?')
      .get(msgId) as { attempt_count: number };
    expect(row.attempt_count).toBe(2);
  });

  it('listPendingOutbound returns pending rows for adapter up to limit in created_at order', () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) {
      insertOutbound(db.raw, {
        message_id: id,
        session_id: 'sess',
        adapter: 'telegram',
        recipient: '1',
        content: id,
        meta: {},
        files: [],
      });
    }
    markOutboundSent(db.raw, ids[1]!, 'x');
    const rows = listPendingOutbound(db.raw, 'telegram', 10);
    expect(rows.map((r) => r.message_id)).toEqual([ids[0], ids[2]]);
  });
});
