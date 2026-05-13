-- Replace plaintext pair_codes table with a hashed-at-rest variant.
--
-- Pre-release migration: existing rows are short-lived (10-minute TTL) and
-- carry no value beyond the redemption window, so we drop them outright.
-- Anyone with an in-flight code will simply request a fresh one.
DROP INDEX IF EXISTS idx_pair_codes_adapter_sender;
DROP TABLE IF EXISTS pair_codes;

CREATE TABLE pair_codes_v2 (
  id              BLOB PRIMARY KEY,         -- 16 random bytes
  code_hash       BLOB NOT NULL,            -- sha256(code || salt), 32 bytes
  salt            BLOB NOT NULL,            -- 16 random bytes per row
  adapter         TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  sender_metadata TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);
CREATE INDEX idx_pair_codes_v2_expires ON pair_codes_v2 (expires_at);
CREATE INDEX idx_pair_codes_v2_adapter_sender ON pair_codes_v2 (adapter, sender_id);
