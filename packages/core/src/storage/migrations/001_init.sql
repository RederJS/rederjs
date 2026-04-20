CREATE TABLE sessions (
  session_id      TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  shim_token_hash TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_seen_at    TEXT,
  state           TEXT NOT NULL CHECK (state IN ('registered', 'connected', 'disconnected', 'revoked'))
);

CREATE TABLE bindings (
  binding_id      TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(session_id),
  adapter         TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  metadata        TEXT,
  UNIQUE (adapter, sender_id, session_id)
);

CREATE TABLE inbound_messages (
  message_id      TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  adapter         TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  correlation_id  TEXT,
  content         TEXT NOT NULL,
  meta_json       TEXT NOT NULL,
  files_json      TEXT NOT NULL,
  idempotency_key TEXT,
  received_at     TEXT NOT NULL,
  delivered_at    TEXT,
  acknowledged_at TEXT,
  state           TEXT NOT NULL CHECK (state IN ('received', 'delivered', 'acknowledged', 'failed')),
  UNIQUE (adapter, idempotency_key)
);
CREATE INDEX idx_inbound_state_session ON inbound_messages (state, session_id, received_at);

CREATE TABLE outbound_messages (
  message_id       TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  adapter          TEXT NOT NULL,
  recipient        TEXT NOT NULL,
  correlation_id   TEXT,
  content          TEXT NOT NULL,
  meta_json        TEXT NOT NULL,
  files_json       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  sent_at          TEXT,
  transport_msg_id TEXT,
  state            TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed', 'expired')),
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT
);
CREATE INDEX idx_outbound_state_adapter ON outbound_messages (state, adapter, created_at);

CREATE TABLE permission_requests (
  request_id      TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  tool_input      TEXT NOT NULL,
  description     TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  resolved_at     TEXT,
  verdict         TEXT CHECK (verdict IN ('allow', 'deny', 'timeout', 'terminal')),
  respondent      TEXT
);

CREATE TABLE persistent_approvals (
  approval_id     TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  input_signature TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  respondent      TEXT NOT NULL,
  UNIQUE (session_id, tool_name, input_signature)
);

CREATE TABLE adapter_kv (
  adapter         TEXT NOT NULL,
  key             TEXT NOT NULL,
  value           BLOB NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (adapter, key)
);
