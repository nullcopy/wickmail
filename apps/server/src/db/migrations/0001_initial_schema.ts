import type { Migration } from "../migrations.js";

const UP = `
CREATE TABLE aliases (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  local_part TEXT NOT NULL,
  domain TEXT NOT NULL,
  label TEXT NOT NULL,
  purpose TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  disabled_at INTEGER,
  last_inbound_at INTEGER,
  last_user_activity_at INTEGER,
  policy_version INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_aliases_expires_at ON aliases (expires_at);
CREATE INDEX idx_aliases_created_at ON aliases (created_at);
CREATE INDEX idx_aliases_last_inbound_at ON aliases (last_inbound_at);
CREATE INDEX idx_aliases_last_user_activity_at ON aliases (last_user_activity_at);

CREATE TABLE alias_lease_policy (
  alias_id TEXT PRIMARY KEY REFERENCES aliases (id) ON DELETE CASCADE,
  lease_duration_seconds INTEGER NOT NULL CHECK (lease_duration_seconds > 0),
  renew_on_outbound INTEGER NOT NULL DEFAULT 1 CHECK (renew_on_outbound IN (0, 1))
);

CREATE TABLE message_provenance (
  message_id TEXT PRIMARY KEY,
  primary_received INTEGER NOT NULL DEFAULT 0 CHECK (primary_received IN (0, 1)),
  envelope_recipients TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE message_provenance_aliases (
  message_id TEXT NOT NULL REFERENCES message_provenance (message_id) ON DELETE CASCADE,
  alias_id TEXT NOT NULL REFERENCES aliases (id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, alias_id)
);

CREATE INDEX idx_provenance_aliases_alias ON message_provenance_aliases (alias_id);

CREATE TABLE quarantine_messages (
  message_id TEXT PRIMARY KEY,
  sender TEXT,
  subject TEXT,
  received_at INTEGER NOT NULL,
  quarantine_expires_at INTEGER,
  status TEXT NOT NULL CHECK (
    status IN ('quarantined', 'recovering', 'recovered', 'deleting', 'deleted')
  ),
  mailbox TEXT,
  uid_validity INTEGER,
  uid INTEGER,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_quarantine_messages_status ON quarantine_messages (status);
CREATE INDEX idx_quarantine_messages_expires_at ON quarantine_messages (quarantine_expires_at);

CREATE TABLE quarantine_message_aliases (
  message_id TEXT NOT NULL REFERENCES quarantine_messages (message_id) ON DELETE CASCADE,
  alias_id TEXT NOT NULL REFERENCES aliases (id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, alias_id)
);

CREATE INDEX idx_quarantine_aliases_alias ON quarantine_message_aliases (alias_id);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  alias_id TEXT REFERENCES aliases (id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_events_alias ON audit_events (alias_id, occurred_at);
CREATE INDEX idx_audit_events_occurred_at ON audit_events (occurred_at);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER
);

CREATE INDEX idx_api_tokens_token_hash ON api_tokens (token_hash);
`;

const DOWN = `
DROP TABLE IF EXISTS api_tokens;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS quarantine_message_aliases;
DROP TABLE IF EXISTS quarantine_messages;
DROP TABLE IF EXISTS message_provenance_aliases;
DROP TABLE IF EXISTS message_provenance;
DROP TABLE IF EXISTS alias_lease_policy;
DROP TABLE IF EXISTS aliases;
`;

/**
 * The initial schema: aliases, lease policy, provenance, quarantine metadata,
 * audit events, and API tokens. Timestamps are epoch milliseconds in UTC.
 */
export const initialSchemaMigration: Migration = {
  version: 1,
  name: "initial_schema",
  up: (db) => {
    db.exec(UP);
  },
  down: (db) => {
    db.exec(DOWN);
  },
};
