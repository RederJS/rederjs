CREATE TABLE pair_codes (
  code            TEXT PRIMARY KEY,
  adapter         TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  sender_metadata TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);
CREATE INDEX idx_pair_codes_adapter_sender ON pair_codes (adapter, sender_id);
