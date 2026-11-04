import type { Migration } from "../migrations.js";

const UP = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE aliases ADD COLUMN owner_id TEXT REFERENCES users (id);
CREATE INDEX idx_aliases_owner ON aliases (owner_id);

ALTER TABLE api_tokens ADD COLUMN user_id TEXT REFERENCES users (id);
CREATE INDEX idx_api_tokens_user ON api_tokens (user_id);

CREATE TABLE setup_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  used_at INTEGER
);

CREATE INDEX idx_setup_tokens_token_hash ON setup_tokens (token_hash);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  user_agent TEXT
);

CREATE INDEX idx_sessions_token_hash ON sessions (token_hash);
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX idx_recovery_codes_code_hash ON recovery_codes (code_hash);

CREATE TABLE mail_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX idx_mail_credentials_user ON mail_credentials (user_id);

CREATE TABLE passkey_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX idx_passkey_credentials_user ON passkey_credentials (user_id);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
  challenge TEXT NOT NULL,
  user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_auth_challenges_expires ON auth_challenges (expires_at);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_idempotency_keys_created ON idempotency_keys (created_at);
`;

const DOWN = `
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS auth_challenges;
DROP TABLE IF EXISTS passkey_credentials;
DROP TABLE IF EXISTS mail_credentials;
DROP TABLE IF EXISTS recovery_codes;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS setup_tokens;
DROP INDEX IF EXISTS idx_api_tokens_user;
ALTER TABLE api_tokens DROP COLUMN user_id;
DROP INDEX IF EXISTS idx_aliases_owner;
ALTER TABLE aliases DROP COLUMN owner_id;
DROP TABLE IF EXISTS users;
`;

/**
 * Management authentication, sessions, passkeys, the separate mail credential,
 * scoped API-token support tables, and mutation idempotency keys. It also adds
 * the alias owner reference the single v1 user owns.
 */
export const authAndAbuseMigration: Migration = {
  version: 2,
  name: "auth_and_abuse",
  up: (db) => {
    db.exec(UP);
  },
  down: (db) => {
    db.exec(DOWN);
  },
};
