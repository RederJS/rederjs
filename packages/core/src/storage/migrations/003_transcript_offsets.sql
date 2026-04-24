CREATE TABLE transcript_offsets (
  session_id      TEXT PRIMARY KEY,
  transcript_path TEXT NOT NULL,
  byte_offset     INTEGER NOT NULL,
  updated_at      TEXT NOT NULL
);
