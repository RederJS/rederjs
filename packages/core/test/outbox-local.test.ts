import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../src/storage/db.js';
import { insertLocalInbound, insertLocalOutbound } from '../src/storage/outbox.js';

let db: DatabaseHandle;

beforeEach(() => {
  db = openDatabase(':memory:');
});
afterEach(() => {
  db.close();
});

describe('insertLocalInbound', () => {
  it('inserts as adapter=local, state=acknowledged', () => {
    const res = insertLocalInbound(db.raw, {
      session_id: 's1',
      content: 'hello',
      uuid: 'u1',
      received_at: '2026-04-24T12:00:00Z',
    });
    expect(res.inserted).toBe(true);
    const row = db.raw
      .prepare(
        'SELECT adapter, sender_id, state, content, idempotency_key FROM inbound_messages WHERE message_id = ?',
      )
      .get(res.message_id) as {
      adapter: string;
      sender_id: string;
      state: string;
      content: string;
      idempotency_key: string;
    };
    expect(row).toMatchObject({
      adapter: 'local',
      sender_id: 'tmux',
      state: 'acknowledged',
      content: 'hello',
      idempotency_key: 'u1',
    });
  });

  it('is idempotent on uuid', () => {
    insertLocalInbound(db.raw, {
      session_id: 's1',
      content: 'hello',
      uuid: 'u1',
      received_at: '2026-04-24T12:00:00Z',
    });
    const dup = insertLocalInbound(db.raw, {
      session_id: 's1',
      content: 'hello',
      uuid: 'u1',
      received_at: '2026-04-24T12:00:00Z',
    });
    expect(dup.inserted).toBe(false);
  });
});

describe('insertLocalOutbound', () => {
  it('inserts as adapter=local with state=sent', () => {
    const res = insertLocalOutbound(db.raw, {
      session_id: 's1',
      content: 'reply',
      uuid: 'a1',
      created_at: '2026-04-24T12:00:01Z',
    });
    expect(res.inserted).toBe(true);
    const row = db.raw
      .prepare(
        'SELECT adapter, recipient, state, content FROM outbound_messages WHERE message_id = ?',
      )
      .get(res.message_id) as {
      adapter: string;
      recipient: string;
      state: string;
      content: string;
    };
    expect(row).toMatchObject({
      adapter: 'local',
      recipient: 'tmux',
      state: 'sent',
      content: 'reply',
    });
  });

  it('is idempotent on uuid', () => {
    insertLocalOutbound(db.raw, {
      session_id: 's1',
      content: 'reply',
      uuid: 'a1',
      created_at: '2026-04-24T12:00:01Z',
    });
    const dup = insertLocalOutbound(db.raw, {
      session_id: 's1',
      content: 'reply',
      uuid: 'a1',
      created_at: '2026-04-24T12:00:01Z',
    });
    expect(dup.inserted).toBe(false);
  });
});
