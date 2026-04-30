import { openSync, closeSync, readSync, statSync } from 'node:fs';
import type { Database as Db } from 'better-sqlite3';
import {
  classifyTranscriptLine,
  classifyTranscriptSummary,
  type ClassifiedEntry,
} from './transcript-parser.js';

export interface ConsumeInput {
  sessionId: string;
  transcriptPath: string;
}

export interface ConsumeResult {
  entries: ClassifiedEntry[];
  latestSummary: string | null;
}

const READ_CHUNK = 64 * 1024;

export async function consumeTranscript(db: Db, input: ConsumeInput): Promise<ConsumeResult> {
  const { sessionId, transcriptPath } = input;

  let size: number;
  try {
    size = statSync(transcriptPath).size;
  } catch {
    return { entries: [], latestSummary: null };
  }

  const stored = db
    .prepare('SELECT byte_offset FROM transcript_offsets WHERE session_id = ?')
    .get(sessionId) as { byte_offset: number } | undefined;

  let start = stored?.byte_offset ?? 0;
  if (start > size) start = 0;

  if (start === size) {
    upsertOffset(db, sessionId, transcriptPath, size);
    return { entries: [], latestSummary: null };
  }

  const fd = openSync(transcriptPath, 'r');
  try {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    let pos = start;
    while (pos < size) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK, size - pos));
      const read = readSync(fd, chunk, 0, chunk.length, pos);
      if (read <= 0) break;
      chunks.push(chunk.subarray(0, read));
      totalLength += read;
      pos += read;
    }
    const buf = Buffer.concat(chunks, totalLength);

    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return { entries: [], latestSummary: null };
    }
    const consumable = buf.subarray(0, lastNewline + 1).toString('utf8');
    const newOffset = start + lastNewline + 1;

    const entries: ClassifiedEntry[] = [];
    let latestSummary: string | null = null;
    for (const line of consumable.split('\n')) {
      if (line.length === 0) continue;
      const entry = classifyTranscriptLine(line);
      if (entry) {
        entries.push(entry);
        continue;
      }
      const summary = classifyTranscriptSummary(line);
      if (summary !== null) latestSummary = summary;
    }

    upsertOffset(db, sessionId, transcriptPath, newOffset);
    return { entries, latestSummary };
  } finally {
    closeSync(fd);
  }
}

function upsertOffset(db: Db, sessionId: string, path: string, offset: number): void {
  db.prepare(
    `INSERT INTO transcript_offsets (session_id, transcript_path, byte_offset, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       transcript_path = excluded.transcript_path,
       byte_offset = excluded.byte_offset,
       updated_at = excluded.updated_at`,
  ).run(sessionId, path, offset, new Date().toISOString());
}
