import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DatabaseHandle } from '../src/storage/db.js';
import { consumeTranscript } from '../src/transcript-tail.js';

let dir: string;
let db: DatabaseHandle;
let tPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-'));
  db = openDatabase(':memory:');
  tPath = join(dir, 'session.jsonl');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const USER = (uuid: string, text: string): string =>
  JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-04-24T12:00:00Z',
    message: { role: 'user', content: text },
  }) + '\n';
const ASSISTANT = (uuid: string, text: string): string =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-04-24T12:00:01Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n';

describe('consumeTranscript', () => {
  it('returns empty and sets offset when file is empty', async () => {
    writeFileSync(tPath, '');
    const out = await consumeTranscript(db.raw, { sessionId: 's1', transcriptPath: tPath });
    expect(out).toEqual([]);
    const row = db.raw
      .prepare('SELECT byte_offset FROM transcript_offsets WHERE session_id = ?')
      .get('s1') as { byte_offset: number } | undefined;
    expect(row?.byte_offset).toBe(0);
  });

  it('returns all entries on first read', async () => {
    writeFileSync(tPath, USER('u1', 'hi') + ASSISTANT('a1', 'hello'));
    const out = await consumeTranscript(db.raw, { sessionId: 's1', transcriptPath: tPath });
    expect(out.map((e) => e.uuid)).toEqual(['u1', 'a1']);
  });

  it('resumes from stored offset on second read', async () => {
    writeFileSync(tPath, USER('u1', 'hi'));
    await consumeTranscript(db.raw, { sessionId: 's1', transcriptPath: tPath });
    appendFileSync(tPath, ASSISTANT('a1', 'hello'));
    const out = await consumeTranscript(db.raw, { sessionId: 's1', transcriptPath: tPath });
    expect(out.map((e) => e.uuid)).toEqual(['a1']);
  });

  it('does not advance past a trailing partial line', async () => {
    const full = USER('u1', 'hi');
    const asstLine = ASSISTANT('a1', 'hello');
    const partial = asstLine.slice(0, 20);
    writeFileSync(tPath, full + partial);
    const out1 = await consumeTranscript(db.raw, { sessionId: 's1', transcriptPath: tPath });
    expect(out1.map((e) => e.uuid)).toEqual(['u1']);
    appendFileSync(tPath, asstLine.slice(20));
    const out2 = await consumeTranscript(db.raw, { sessionId: 's1', transcriptPath: tPath });
    expect(out2.map((e) => e.uuid)).toEqual(['a1']);
  });

  it('restarts from zero when file shrinks below stored offset', async () => {
    writeFileSync(tPath, USER('u1', 'a long prompt that makes the line sizeable'));
    await consumeTranscript(db.raw, { sessionId: 's1', transcriptPath: tPath });
    truncateSync(tPath, 0);
    writeFileSync(tPath, USER('u2', 'x'));
    const out = await consumeTranscript(db.raw, { sessionId: 's1', transcriptPath: tPath });
    expect(out.map((e) => e.uuid)).toEqual(['u2']);
  });

  it('returns empty when file does not exist', async () => {
    const out = await consumeTranscript(db.raw, {
      sessionId: 's1',
      transcriptPath: join(dir, 'missing.jsonl'),
    });
    expect(out).toEqual([]);
  });
});
