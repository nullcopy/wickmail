//! SQLite storage and versioned migrations.
//!
//! SQLite runs with write-ahead logging, foreign keys enabled, and a busy
//! timeout. Timestamps are stored as epoch milliseconds in UTC. Migrations are
//! versioned and apply forward and revert cleanly; the current version is
//! tracked in SQLite's `user_version`.

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, Row, params};
use thiserror::Error;

use crate::address::CanonicalAddress;
use crate::alias::{Alias, AliasId};
use crate::audit::{AuditEvent, AuditEventId, AuditEventKind};
use crate::identity::{
    MailCredential, PasskeyRecord, RecoveryCode, Session, SessionId, User, UserId,
};
use crate::mail::store::MailboxLocator;
use crate::message::{Message, MessageId, Route};
use crate::quarantine::{QuarantineKind, QuarantineMetadata, QuarantineStatus};
use crate::token::{ApiToken, ScopeSet, TokenId};

/// A single forward-and-revert database migration.
#[derive(Clone, Copy, Debug)]
pub struct Migration {
    /// Monotonic version, starting at 1.
    pub version: i64,
    /// Human-readable name.
    pub name: &'static str,
    /// SQL applied when moving forward to this version.
    pub up: &'static str,
    /// SQL applied when reverting from this version.
    pub down: &'static str,
}

/// The ordered migration list.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "aliases",
        up: "\
CREATE TABLE aliases (
    id TEXT PRIMARY KEY NOT NULL,
    address TEXT NOT NULL,
    label TEXT,
    purpose TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    disabled_at INTEGER,
    lease_duration_seconds INTEGER NOT NULL,
    renew_on_outbound INTEGER NOT NULL,
    last_inbound_at INTEGER,
    last_user_activity_at INTEGER,
    policy_version INTEGER NOT NULL
);
CREATE UNIQUE INDEX aliases_address_unique ON aliases (address);
",
        down: "\
DROP INDEX aliases_address_unique;
DROP TABLE aliases;
",
    },
    Migration {
        version: 2,
        name: "policy",
        up: "\
CREATE TABLE policy (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
",
        down: "DROP TABLE policy;\n",
    },
    Migration {
        version: 3,
        name: "messages",
        up: "\
CREATE TABLE messages (
    id TEXT PRIMARY KEY NOT NULL,
    sender TEXT NOT NULL,
    subject TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    route TEXT NOT NULL,
    primary_received INTEGER NOT NULL
);
CREATE TABLE message_aliases (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    alias_id TEXT NOT NULL REFERENCES aliases(id),
    PRIMARY KEY (message_id, alias_id)
);
CREATE INDEX message_aliases_alias_idx ON message_aliases (alias_id);
",
        down: "\
DROP INDEX message_aliases_alias_idx;
DROP TABLE message_aliases;
DROP TABLE messages;
",
    },
    Migration {
        version: 4,
        name: "quarantine_metadata",
        up: "\
CREATE TABLE quarantine_metadata (
    id TEXT PRIMARY KEY NOT NULL,
    message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
    status TEXT NOT NULL,
    sender TEXT NOT NULL,
    subject TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    quarantine_expires_at INTEGER NOT NULL,
    mailbox TEXT,
    uidvalidity INTEGER,
    uid INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX quarantine_metadata_status_idx ON quarantine_metadata (status);
",
        down: "\
DROP INDEX quarantine_metadata_status_idx;
DROP TABLE quarantine_metadata;
",
    },
    Migration {
        version: 5,
        name: "audit_events",
        up: "\
CREATE TABLE audit_events (
    id TEXT PRIMARY KEY NOT NULL,
    alias_id TEXT NOT NULL REFERENCES aliases(id),
    kind TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX audit_events_alias_idx ON audit_events (alias_id, created_at);
",
        down: "\
DROP INDEX audit_events_alias_idx;
DROP TABLE audit_events;
",
    },
    Migration {
        version: 6,
        name: "api_tokens",
        up: "\
CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    scopes TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    last_used_at INTEGER
);
",
        down: "DROP TABLE api_tokens;\n",
    },
    Migration {
        version: 7,
        name: "quarantine_lifecycle",
        up: "\
ALTER TABLE quarantine_metadata ADD COLUMN kind TEXT NOT NULL DEFAULT 'lease';
ALTER TABLE quarantine_metadata ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quarantine_metadata ADD COLUMN idempotency_key TEXT;
ALTER TABLE quarantine_metadata ADD COLUMN delete_reason TEXT;
ALTER TABLE quarantine_metadata ADD COLUMN recovered_at INTEGER;
ALTER TABLE quarantine_metadata ADD COLUMN deleted_at INTEGER;
CREATE INDEX quarantine_metadata_kind_status_idx
    ON quarantine_metadata (kind, status, quarantine_expires_at);
",
        down: "\
DROP INDEX quarantine_metadata_kind_status_idx;
ALTER TABLE quarantine_metadata DROP COLUMN deleted_at;
ALTER TABLE quarantine_metadata DROP COLUMN recovered_at;
ALTER TABLE quarantine_metadata DROP COLUMN delete_reason;
ALTER TABLE quarantine_metadata DROP COLUMN idempotency_key;
ALTER TABLE quarantine_metadata DROP COLUMN size_bytes;
ALTER TABLE quarantine_metadata DROP COLUMN kind;
",
    },
    Migration {
        version: 8,
        name: "identity",
        up: "\
CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL UNIQUE,
    primary_address TEXT NOT NULL,
    password_hash TEXT,
    created_at INTEGER NOT NULL,
    password_changed_at INTEGER,
    setup_token_hash TEXT,
    setup_token_expires_at INTEGER,
    setup_completed_at INTEGER
);
CREATE TABLE sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_token_hash_idx ON sessions (token_hash);
CREATE TABLE recovery_codes (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER
);
CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_id);
CREATE TABLE passkeys (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    credential TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
);
CREATE TABLE mail_credentials (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    password_hash TEXT,
    created_at INTEGER NOT NULL,
    rotated_at INTEGER,
    revoked_at INTEGER
);
CREATE TABLE idempotency_keys (
    key TEXT PRIMARY KEY NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_status INTEGER NOT NULL,
    response_body TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
ALTER TABLE api_tokens ADD COLUMN prefix TEXT;
ALTER TABLE api_tokens ADD COLUMN user_id TEXT REFERENCES users(id);
",
        down: "\
ALTER TABLE api_tokens DROP COLUMN user_id;
ALTER TABLE api_tokens DROP COLUMN prefix;
DROP TABLE idempotency_keys;
DROP TABLE mail_credentials;
DROP TABLE passkeys;
DROP INDEX recovery_codes_user_idx;
DROP TABLE recovery_codes;
DROP INDEX sessions_token_hash_idx;
DROP INDEX sessions_user_idx;
DROP TABLE sessions;
DROP TABLE users;
",
    },
];

/// The highest known migration version.
pub fn latest_version() -> i64 {
    MIGRATIONS.last().map_or(0, |migration| migration.version)
}

/// Storage failures.
#[derive(Debug, Error)]
pub enum StoreError {
    /// The underlying SQLite error.
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
    /// The requested migration target does not exist.
    #[error("unknown migration version: {0}")]
    UnknownMigration(i64),
    /// An optimistic concurrency check failed.
    #[error("alias {0} changed since it was read")]
    VersionConflict(AliasId),
    /// The alias does not exist.
    #[error("alias not found: {0}")]
    NotFound(AliasId),
    /// The management user does not exist.
    #[error("user not found: {0}")]
    MissingUser(UserId),
    /// Stored data could not be decoded.
    #[error("invalid stored data: {0}")]
    Corrupt(String),
}

/// A single-owner connection to the Wickmail database.
pub struct Store {
    connection: Connection,
}

/// A stored idempotent mutation response.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdempotencyRecord {
    /// Client-supplied idempotency key.
    pub key: String,
    /// HTTP method.
    pub method: String,
    /// Request path.
    pub path: String,
    /// Hash of the request body.
    pub request_hash: String,
    /// Stored response status code.
    pub response_status: i64,
    /// Stored response body.
    pub response_body: String,
    /// When the record was written.
    pub created_at: crate::timestamp::Timestamp,
}

impl Store {
    /// Opens a database file and configures the connection.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let connection = Connection::open(path)?;
        Self::configure(&connection)?;
        Ok(Self { connection })
    }

    /// Opens an in-memory database and configures the connection.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let connection = Connection::open_in_memory()?;
        Self::configure(&connection)?;
        Ok(Self { connection })
    }

    fn configure(connection: &Connection) -> Result<(), StoreError> {
        // Write-ahead logging is a no-op for in-memory databases, which report
        // "memory" instead of "wal".
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(Duration::from_secs(5))?;
        Ok(())
    }

    /// The underlying connection.
    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    /// The current schema version.
    pub fn schema_version(&self) -> Result<i64, StoreError> {
        let version = self
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
        Ok(version)
    }

    /// Applies all pending migrations.
    pub fn migrate(&mut self) -> Result<(), StoreError> {
        self.migrate_to(latest_version())
    }

    /// Applies or reverts migrations until the schema is at `target`.
    pub fn migrate_to(&mut self, target: i64) -> Result<(), StoreError> {
        if target < 0 || target > latest_version() {
            return Err(StoreError::UnknownMigration(target));
        }
        let current = self.schema_version()?;
        if target == current {
            return Ok(());
        }
        let transaction = self.connection.transaction()?;
        if target > current {
            for migration in MIGRATIONS
                .iter()
                .filter(|migration| migration.version > current && migration.version <= target)
            {
                transaction.execute_batch(migration.up)?;
                transaction.pragma_update(None, "user_version", migration.version)?;
            }
        } else {
            for migration in MIGRATIONS
                .iter()
                .rev()
                .filter(|migration| migration.version <= current && migration.version > target)
            {
                transaction.execute_batch(migration.down)?;
                transaction.pragma_update(None, "user_version", migration.version - 1)?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    /// Inserts a new alias.
    pub fn insert_alias(&self, alias: &Alias) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO aliases (
                id, address, label, purpose, created_at, expires_at, disabled_at,
                lease_duration_seconds, renew_on_outbound, last_inbound_at,
                last_user_activity_at, policy_version
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                alias.id,
                alias.address,
                alias.label,
                alias.purpose,
                alias.created_at,
                alias.expires_at,
                alias.disabled_at,
                alias.lease_duration_seconds,
                alias.renew_on_outbound,
                alias.last_inbound_at,
                alias.last_user_activity_at,
                alias.policy_version,
            ],
        )?;
        Ok(())
    }

    /// Loads an alias by identifier.
    pub fn get_alias(&self, id: AliasId) -> Result<Option<Alias>, StoreError> {
        self.connection
            .query_row(
                &format!("SELECT {ALIAS_COLUMNS} FROM aliases WHERE id = ?1"),
                params![id],
                row_to_alias,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Loads an alias by canonical address.
    pub fn get_alias_by_address(
        &self,
        address: &CanonicalAddress,
    ) -> Result<Option<Alias>, StoreError> {
        self.connection
            .query_row(
                &format!("SELECT {ALIAS_COLUMNS} FROM aliases WHERE address = ?1"),
                params![address],
                row_to_alias,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Reports whether a canonical address is already stored.
    pub fn address_exists(&self, address: &CanonicalAddress) -> Result<bool, StoreError> {
        let exists = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM aliases WHERE address = ?1)",
            params![address],
            |row| row.get::<_, bool>(0),
        )?;
        Ok(exists)
    }

    /// Updates an alias using its `policy_version` for optimistic concurrency.
    ///
    /// The caller must increment `policy_version` before calling; the previous
    /// version is used in the `WHERE` clause.
    pub fn update_alias(&self, alias: &Alias) -> Result<(), StoreError> {
        let previous_version = alias.policy_version - 1;
        let changed = self.connection.execute(
            "UPDATE aliases SET
                address = ?2,
                label = ?3,
                purpose = ?4,
                created_at = ?5,
                expires_at = ?6,
                disabled_at = ?7,
                lease_duration_seconds = ?8,
                renew_on_outbound = ?9,
                last_inbound_at = ?10,
                last_user_activity_at = ?11,
                policy_version = ?12
            WHERE id = ?1 AND policy_version = ?13",
            params![
                alias.id,
                alias.address,
                alias.label,
                alias.purpose,
                alias.created_at,
                alias.expires_at,
                alias.disabled_at,
                alias.lease_duration_seconds,
                alias.renew_on_outbound,
                alias.last_inbound_at,
                alias.last_user_activity_at,
                alias.policy_version,
                previous_version,
            ],
        )?;
        if changed == 0 {
            return Err(StoreError::VersionConflict(alias.id));
        }
        Ok(())
    }

    /// Lists all aliases in a deterministic order.
    pub fn list_aliases(&self) -> Result<Vec<Alias>, StoreError> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT {ALIAS_COLUMNS} FROM aliases ORDER BY created_at ASC, id ASC"
        ))?;
        let rows = statement.query_map([], row_to_alias)?;
        let mut aliases = Vec::new();
        for row in rows {
            aliases.push(row?);
        }
        Ok(aliases)
    }

    /// Inserts an audit event.
    pub fn insert_audit_event(&self, event: &AuditEvent) -> Result<(), StoreError> {
        let detail = match &event.detail {
            Some(detail) => Some(
                serde_json::to_string(detail)
                    .map_err(|error| StoreError::Corrupt(error.to_string()))?,
            ),
            None => None,
        };
        self.connection.execute(
            "INSERT INTO audit_events (id, alias_id, kind, detail, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                event.id,
                event.alias_id,
                audit_kind_to_str(event.kind),
                detail,
                event.created_at,
            ],
        )?;
        Ok(())
    }

    /// Lists an alias's audit events, oldest first.
    pub fn list_audit_events(&self, alias_id: AliasId) -> Result<Vec<AuditEvent>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, alias_id, kind, detail, created_at
             FROM audit_events WHERE alias_id = ?1
             ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows = statement.query_map(params![alias_id], |row| {
            let kind_text: String = row.get("kind")?;
            let detail_text: Option<String> = row.get("detail")?;
            let detail = match detail_text {
                Some(text) => Some(serde_json::from_str(&text).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?),
                None => None,
            };
            Ok(AuditEvent {
                id: row.get::<_, AuditEventId>("id")?,
                alias_id: row.get::<_, AliasId>("alias_id")?,
                kind: audit_kind_from_str(&kind_text)?,
                created_at: row.get("created_at")?,
                detail,
            })
        })?;
        let mut events = Vec::new();
        for row in rows {
            events.push(row?);
        }
        Ok(events)
    }

    /// Records an accepted inbound message and its provenance.
    ///
    /// The message row and its alias links are written in one transaction, and
    /// each receiving alias's `last_inbound_at` is advanced without touching
    /// `expires_at`. Recording is idempotent so a spool retry does not fail.
    pub fn record_inbound_delivery(&self, message: &Message) -> Result<(), StoreError> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "INSERT OR IGNORE INTO messages
                (id, sender, subject, received_at, route, primary_received)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                message.id,
                message.sender,
                message.subject,
                message.received_at,
                route_to_str(message.route),
                message.primary_received,
            ],
        )?;
        for alias_id in &message.alias_ids {
            transaction.execute(
                "INSERT OR IGNORE INTO message_aliases (message_id, alias_id)
                 VALUES (?1, ?2)",
                params![message.id, alias_id],
            )?;
            transaction.execute(
                "UPDATE aliases SET
                    last_inbound_at = max(coalesce(last_inbound_at, ?2), ?2),
                    policy_version = policy_version + 1
                 WHERE id = ?1",
                params![alias_id, message.received_at],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Loads delivery metadata by message identity.
    pub fn get_message(&self, id: MessageId) -> Result<Option<Message>, StoreError> {
        let message = self
            .connection
            .query_row(
                "SELECT id, sender, subject, received_at, route, primary_received
                 FROM messages WHERE id = ?1",
                params![id],
                |row| {
                    let route_text: String = row.get("route")?;
                    Ok((
                        row.get::<_, MessageId>("id")?,
                        row.get::<_, String>("sender")?,
                        row.get::<_, String>("subject")?,
                        row.get::<_, crate::timestamp::Timestamp>("received_at")?,
                        route_text,
                        row.get::<_, bool>("primary_received")?,
                    ))
                },
            )
            .optional()?;
        let Some((id, sender, subject, received_at, route_text, primary_received)) = message else {
            return Ok(None);
        };
        let mut statement = self.connection.prepare(
            "SELECT alias_id FROM message_aliases WHERE message_id = ?1 ORDER BY alias_id",
        )?;
        let alias_ids = statement
            .query_map(params![id], |row| row.get::<_, AliasId>("alias_id"))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(Message {
            id,
            alias_ids,
            primary_received,
            sender,
            subject,
            received_at,
            route: route_from_str(&route_text)?,
        }))
    }

    /// Records delivery metadata without touching aliases.
    ///
    /// Used when reconciliation rebuilds quarantine metadata from the mail
    /// store and no delivery row exists. Recording is idempotent.
    pub fn ensure_message(&self, message: &Message) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT OR IGNORE INTO messages
                (id, sender, subject, received_at, route, primary_received)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                message.id,
                message.sender,
                message.subject,
                message.received_at,
                route_to_str(message.route),
                message.primary_received,
            ],
        )?;
        Ok(())
    }

    /// Links a message to an alias, ignoring duplicates.
    ///
    /// Used when reconciliation rebuilds delivery metadata from the mail store.
    pub fn link_message_alias(
        &self,
        message_id: MessageId,
        alias_id: AliasId,
    ) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT OR IGNORE INTO message_aliases (message_id, alias_id) VALUES (?1, ?2)",
            params![message_id, alias_id],
        )?;
        Ok(())
    }

    /// Inserts quarantine metadata, leaving an existing row untouched.
    pub fn insert_quarantine_metadata(
        &self,
        metadata: &QuarantineMetadata,
    ) -> Result<(), StoreError> {
        self.write_quarantine_metadata(metadata, true)
    }

    /// Inserts or replaces quarantine metadata.
    pub fn upsert_quarantine_metadata(
        &self,
        metadata: &QuarantineMetadata,
    ) -> Result<(), StoreError> {
        self.write_quarantine_metadata(metadata, false)
    }

    fn write_quarantine_metadata(
        &self,
        metadata: &QuarantineMetadata,
        keep_existing: bool,
    ) -> Result<(), StoreError> {
        let (verb, conflict) = if keep_existing {
            ("INSERT OR IGNORE", "")
        } else {
            (
                "INSERT",
                "ON CONFLICT(message_id) DO UPDATE SET
                    status = excluded.status,
                    kind = excluded.kind,
                    sender = excluded.sender,
                    subject = excluded.subject,
                    received_at = excluded.received_at,
                    quarantine_expires_at = excluded.quarantine_expires_at,
                    mailbox = excluded.mailbox,
                    uidvalidity = excluded.uidvalidity,
                    uid = excluded.uid,
                    size_bytes = excluded.size_bytes,
                    idempotency_key = excluded.idempotency_key,
                    delete_reason = excluded.delete_reason,
                    updated_at = excluded.updated_at,
                    recovered_at = excluded.recovered_at,
                    deleted_at = excluded.deleted_at",
            )
        };
        let sql = format!(
            "{verb} INTO quarantine_metadata (
                id, message_id, status, kind, sender, subject, received_at,
                quarantine_expires_at, mailbox, uidvalidity, uid, size_bytes,
                idempotency_key, delete_reason, created_at, updated_at,
                recovered_at, deleted_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18
            ) {conflict}"
        );
        let (mailbox, uidvalidity, uid) = match &metadata.locator {
            Some(locator) => (
                Some(locator.mailbox.clone()),
                Some(locator.uidvalidity),
                Some(locator.uid),
            ),
            None => (None, None, None),
        };
        self.connection.execute(
            &sql,
            params![
                metadata.message_id.to_string(),
                metadata.message_id,
                quarantine_status_to_str(metadata.status),
                quarantine_kind_to_str(metadata.kind),
                metadata.sender,
                metadata.subject,
                metadata.received_at,
                metadata.quarantine_expires_at,
                mailbox,
                uidvalidity,
                uid,
                metadata.size_bytes as i64,
                metadata.idempotency_key,
                metadata.delete_reason,
                metadata.created_at,
                metadata.updated_at,
                metadata.recovered_at,
                metadata.deleted_at,
            ],
        )?;
        Ok(())
    }

    /// Loads quarantine metadata by message identity.
    pub fn get_quarantine_metadata(
        &self,
        message_id: MessageId,
    ) -> Result<Option<QuarantineMetadata>, StoreError> {
        let mut metadata = self
            .connection
            .query_row(
                &format!(
                    "SELECT {QUARANTINE_COLUMNS} FROM quarantine_metadata WHERE message_id = ?1"
                ),
                params![message_id],
                row_to_quarantine,
            )
            .optional()?;
        if let Some(metadata) = metadata.as_mut() {
            metadata.alias_ids = self.quarantine_alias_ids(message_id)?;
        }
        Ok(metadata)
    }

    /// Lists quarantine metadata, oldest received first.
    pub fn list_quarantine_metadata(&self) -> Result<Vec<QuarantineMetadata>, StoreError> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT {QUARANTINE_COLUMNS} FROM quarantine_metadata
             ORDER BY received_at ASC, message_id ASC"
        ))?;
        let rows = statement.query_map([], row_to_quarantine)?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }
        for entry in &mut entries {
            entry.alias_ids = self.quarantine_alias_ids(entry.message_id)?;
        }
        Ok(entries)
    }

    /// Deletes quarantine metadata by message identity.
    pub fn delete_quarantine_metadata(&self, message_id: MessageId) -> Result<bool, StoreError> {
        let removed = self.connection.execute(
            "DELETE FROM quarantine_metadata WHERE message_id = ?1",
            params![message_id],
        )?;
        Ok(removed > 0)
    }

    /// Purges metadata for messages deleted at or before `cutoff`.
    ///
    /// Returns the number of rows removed.
    pub fn purge_deleted_quarantine_metadata(
        &self,
        cutoff: crate::timestamp::Timestamp,
    ) -> Result<usize, StoreError> {
        let removed = self.connection.execute(
            "DELETE FROM quarantine_metadata
             WHERE status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at <= ?1",
            params![cutoff],
        )?;
        Ok(removed)
    }

    fn quarantine_alias_ids(&self, message_id: MessageId) -> Result<Vec<AliasId>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT alias_id FROM message_aliases WHERE message_id = ?1 ORDER BY alias_id",
        )?;
        let ids = statement
            .query_map(params![message_id], |row| row.get::<_, AliasId>("alias_id"))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    /// Inserts the single management user.
    pub fn insert_user(&self, user: &User) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO users (
                id, username, primary_address, password_hash, created_at,
                password_changed_at, setup_token_hash, setup_token_expires_at,
                setup_completed_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                user.id,
                user.username,
                user.primary_address,
                user.password_hash,
                user.created_at,
                user.password_changed_at,
                user.setup_token_hash,
                user.setup_token_expires_at,
                user.setup_completed_at,
            ],
        )?;
        Ok(())
    }

    /// Loads the single management user, if one exists.
    pub fn get_user(&self) -> Result<Option<User>, StoreError> {
        self.connection
            .query_row(
                &format!("SELECT {USER_COLUMNS} FROM users ORDER BY created_at ASC LIMIT 1"),
                [],
                row_to_user,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Loads a user by identifier.
    pub fn get_user_by_id(&self, id: UserId) -> Result<Option<User>, StoreError> {
        self.connection
            .query_row(
                &format!("SELECT {USER_COLUMNS} FROM users WHERE id = ?1"),
                params![id],
                row_to_user,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Updates the management user.
    pub fn update_user(&self, user: &User) -> Result<(), StoreError> {
        let changed = self.connection.execute(
            "UPDATE users SET
                username = ?2,
                primary_address = ?3,
                password_hash = ?4,
                created_at = ?5,
                password_changed_at = ?6,
                setup_token_hash = ?7,
                setup_token_expires_at = ?8,
                setup_completed_at = ?9
             WHERE id = ?1",
            params![
                user.id,
                user.username,
                user.primary_address,
                user.password_hash,
                user.created_at,
                user.password_changed_at,
                user.setup_token_hash,
                user.setup_token_expires_at,
                user.setup_completed_at,
            ],
        )?;
        if changed == 0 {
            return Err(StoreError::MissingUser(user.id));
        }
        Ok(())
    }

    /// Inserts a session.
    pub fn insert_session(&self, session: &Session) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO sessions (
                id, user_id, token_hash, csrf_token, created_at, last_used_at,
                expires_at, revoked_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                session.id,
                session.user_id,
                session.token_hash,
                session.csrf_token,
                session.created_at,
                session.last_used_at,
                session.expires_at,
                session.revoked_at,
            ],
        )?;
        Ok(())
    }

    /// Loads a session by its token hash.
    pub fn get_session_by_hash(&self, hash: &str) -> Result<Option<Session>, StoreError> {
        self.connection
            .query_row(
                &format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE token_hash = ?1"),
                params![hash],
                row_to_session,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Loads a session by identifier.
    pub fn get_session(&self, id: SessionId) -> Result<Option<Session>, StoreError> {
        self.connection
            .query_row(
                &format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE id = ?1"),
                params![id],
                row_to_session,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Updates a session's mutable fields.
    pub fn update_session(&self, session: &Session) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE sessions SET
                user_id = ?2,
                token_hash = ?3,
                csrf_token = ?4,
                created_at = ?5,
                last_used_at = ?6,
                expires_at = ?7,
                revoked_at = ?8
             WHERE id = ?1",
            params![
                session.id,
                session.user_id,
                session.token_hash,
                session.csrf_token,
                session.created_at,
                session.last_used_at,
                session.expires_at,
                session.revoked_at,
            ],
        )?;
        Ok(())
    }

    /// Revokes a single session. Returns whether a live session was revoked.
    pub fn revoke_session(
        &self,
        id: SessionId,
        at: crate::timestamp::Timestamp,
    ) -> Result<bool, StoreError> {
        let changed = self.connection.execute(
            "UPDATE sessions SET revoked_at = coalesce(revoked_at, ?2) WHERE id = ?1",
            params![id, at],
        )?;
        Ok(changed > 0)
    }

    /// Revokes every session for a user. Returns the number revoked.
    pub fn revoke_user_sessions(
        &self,
        user_id: UserId,
        at: crate::timestamp::Timestamp,
    ) -> Result<usize, StoreError> {
        let changed = self.connection.execute(
            "UPDATE sessions SET revoked_at = ?2
             WHERE user_id = ?1 AND revoked_at IS NULL",
            params![user_id, at],
        )?;
        Ok(changed)
    }

    /// Lists a user's sessions, newest first.
    pub fn list_user_sessions(&self, user_id: UserId) -> Result<Vec<Session>, StoreError> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT {SESSION_COLUMNS} FROM sessions WHERE user_id = ?1
             ORDER BY created_at DESC, id ASC"
        ))?;
        let rows = statement.query_map(params![user_id], row_to_session)?;
        let mut sessions = Vec::new();
        for row in rows {
            sessions.push(row?);
        }
        Ok(sessions)
    }

    /// Deletes sessions that expired before `before`.
    pub fn delete_expired_sessions(
        &self,
        before: crate::timestamp::Timestamp,
    ) -> Result<usize, StoreError> {
        let removed = self.connection.execute(
            "DELETE FROM sessions WHERE expires_at <= ?1",
            params![before],
        )?;
        Ok(removed)
    }

    /// Inserts a one-time recovery code.
    pub fn insert_recovery_code(&self, code: &RecoveryCode) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO recovery_codes (id, user_id, code_hash, created_at, used_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                code.id,
                code.user_id,
                code.code_hash,
                code.created_at,
                code.used_at
            ],
        )?;
        Ok(())
    }

    /// Lists a user's recovery codes, oldest first.
    pub fn list_recovery_codes(&self, user_id: UserId) -> Result<Vec<RecoveryCode>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, user_id, code_hash, created_at, used_at
             FROM recovery_codes WHERE user_id = ?1 ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement.query_map(params![user_id], |row| {
            Ok(RecoveryCode {
                id: row.get("id")?,
                user_id: row.get("user_id")?,
                code_hash: row.get("code_hash")?,
                created_at: row.get("created_at")?,
                used_at: row.get("used_at")?,
            })
        })?;
        let mut codes = Vec::new();
        for row in rows {
            codes.push(row?);
        }
        Ok(codes)
    }

    /// Marks a recovery code used.
    pub fn update_recovery_code(&self, code: &RecoveryCode) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE recovery_codes SET used_at = ?2 WHERE id = ?1",
            params![code.id, code.used_at],
        )?;
        Ok(())
    }

    /// Deletes every recovery code for a user. Returns the number removed.
    pub fn delete_recovery_codes(&self, user_id: UserId) -> Result<usize, StoreError> {
        let removed = self.connection.execute(
            "DELETE FROM recovery_codes WHERE user_id = ?1",
            params![user_id],
        )?;
        Ok(removed)
    }

    /// Inserts a passkey credential.
    pub fn insert_passkey(&self, record: &PasskeyRecord) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO passkeys (id, user_id, name, credential, created_at, last_used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                record.id,
                record.user_id,
                record.name,
                record.credential,
                record.created_at,
                record.last_used_at,
            ],
        )?;
        Ok(())
    }

    /// Lists a user's passkeys, oldest first.
    pub fn list_passkeys(&self, user_id: UserId) -> Result<Vec<PasskeyRecord>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT id, user_id, name, credential, created_at, last_used_at
             FROM passkeys WHERE user_id = ?1 ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement.query_map(params![user_id], row_to_passkey)?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row?);
        }
        Ok(records)
    }

    /// Loads a passkey by credential identifier.
    pub fn get_passkey(&self, id: &str) -> Result<Option<PasskeyRecord>, StoreError> {
        self.connection
            .query_row(
                "SELECT id, user_id, name, credential, created_at, last_used_at
                 FROM passkeys WHERE id = ?1",
                params![id],
                row_to_passkey,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Deletes a passkey. Returns whether one was removed.
    pub fn delete_passkey(&self, id: &str) -> Result<bool, StoreError> {
        let removed = self
            .connection
            .execute("DELETE FROM passkeys WHERE id = ?1", params![id])?;
        Ok(removed > 0)
    }

    /// Records a passkey use.
    pub fn touch_passkey(
        &self,
        id: &str,
        at: crate::timestamp::Timestamp,
    ) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE passkeys SET last_used_at = ?2 WHERE id = ?1",
            params![id, at],
        )?;
        Ok(())
    }

    /// Updates a passkey's stored credential and last-used time.
    pub fn update_passkey_credential(
        &self,
        id: &str,
        credential: &str,
        at: crate::timestamp::Timestamp,
    ) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE passkeys SET credential = ?2, last_used_at = ?3 WHERE id = ?1",
            params![id, credential, at],
        )?;
        Ok(())
    }

    /// Loads the mail credential, if one exists.
    pub fn get_mail_credential(&self) -> Result<Option<MailCredential>, StoreError> {
        self.connection
            .query_row(
                "SELECT user_id, password_hash, created_at, rotated_at, revoked_at
                 FROM mail_credentials ORDER BY created_at ASC LIMIT 1",
                [],
                |row| {
                    Ok(MailCredential {
                        user_id: row.get("user_id")?,
                        password_hash: row.get("password_hash")?,
                        created_at: row.get("created_at")?,
                        rotated_at: row.get("rotated_at")?,
                        revoked_at: row.get("revoked_at")?,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Inserts or replaces the mail credential.
    pub fn upsert_mail_credential(&self, credential: &MailCredential) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO mail_credentials (user_id, password_hash, created_at, rotated_at, revoked_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(user_id) DO UPDATE SET
                password_hash = excluded.password_hash,
                created_at = excluded.created_at,
                rotated_at = excluded.rotated_at,
                revoked_at = excluded.revoked_at",
            params![
                credential.user_id,
                credential.password_hash,
                credential.created_at,
                credential.rotated_at,
                credential.revoked_at,
            ],
        )?;
        Ok(())
    }

    /// Inserts an API token.
    pub fn insert_api_token(&self, token: &ApiToken) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO api_tokens (
                id, name, token_hash, scopes, created_at, expires_at, revoked_at,
                last_used_at, prefix, user_id
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                token.id,
                token.name,
                token.token_hash,
                token.scopes.to_storage(),
                token.created_at,
                token.expires_at,
                token.revoked_at,
                token.last_used_at,
                token.prefix,
                token.user_id,
            ],
        )?;
        Ok(())
    }

    /// Lists API tokens, newest first.
    pub fn list_api_tokens(&self) -> Result<Vec<ApiToken>, StoreError> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT {TOKEN_COLUMNS} FROM api_tokens ORDER BY created_at DESC, id ASC"
        ))?;
        let rows = statement.query_map([], row_to_token)?;
        let mut tokens = Vec::new();
        for row in rows {
            tokens.push(row?);
        }
        Ok(tokens)
    }

    /// Loads an API token by identifier.
    pub fn get_api_token(&self, id: TokenId) -> Result<Option<ApiToken>, StoreError> {
        self.connection
            .query_row(
                &format!("SELECT {TOKEN_COLUMNS} FROM api_tokens WHERE id = ?1"),
                params![id],
                row_to_token,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Loads an API token by its secret hash.
    pub fn get_api_token_by_hash(&self, hash: &str) -> Result<Option<ApiToken>, StoreError> {
        self.connection
            .query_row(
                &format!("SELECT {TOKEN_COLUMNS} FROM api_tokens WHERE token_hash = ?1"),
                params![hash],
                row_to_token,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Revokes an API token. Returns whether a live token was revoked.
    pub fn revoke_api_token(
        &self,
        id: TokenId,
        at: crate::timestamp::Timestamp,
    ) -> Result<bool, StoreError> {
        let changed = self.connection.execute(
            "UPDATE api_tokens SET revoked_at = coalesce(revoked_at, ?2) WHERE id = ?1",
            params![id, at],
        )?;
        Ok(changed > 0)
    }

    /// Records an API token use.
    pub fn touch_api_token(
        &self,
        id: TokenId,
        at: crate::timestamp::Timestamp,
    ) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE api_tokens SET last_used_at = ?2 WHERE id = ?1",
            params![id, at],
        )?;
        Ok(())
    }

    /// Loads a stored idempotent response.
    pub fn get_idempotency(&self, key: &str) -> Result<Option<IdempotencyRecord>, StoreError> {
        self.connection
            .query_row(
                "SELECT key, method, path, request_hash, response_status, response_body, created_at
                 FROM idempotency_keys WHERE key = ?1",
                params![key],
                |row| {
                    Ok(IdempotencyRecord {
                        key: row.get("key")?,
                        method: row.get("method")?,
                        path: row.get("path")?,
                        request_hash: row.get("request_hash")?,
                        response_status: row.get("response_status")?,
                        response_body: row.get("response_body")?,
                        created_at: row.get("created_at")?,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Stores an idempotent response, replacing an existing record.
    pub fn insert_idempotency(&self, record: &IdempotencyRecord) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO idempotency_keys (
                key, method, path, request_hash, response_status, response_body, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(key) DO UPDATE SET
                method = excluded.method,
                path = excluded.path,
                request_hash = excluded.request_hash,
                response_status = excluded.response_status,
                response_body = excluded.response_body,
                created_at = excluded.created_at",
            params![
                record.key,
                record.method,
                record.path,
                record.request_hash,
                record.response_status,
                record.response_body,
                record.created_at,
            ],
        )?;
        Ok(())
    }

    /// Purges idempotency records created before `before`.
    pub fn purge_idempotency(
        &self,
        before: crate::timestamp::Timestamp,
    ) -> Result<usize, StoreError> {
        let removed = self.connection.execute(
            "DELETE FROM idempotency_keys WHERE created_at <= ?1",
            params![before],
        )?;
        Ok(removed)
    }
}

const USER_COLUMNS: &str = "id, username, primary_address, password_hash, created_at, \
     password_changed_at, setup_token_hash, setup_token_expires_at, setup_completed_at";

fn row_to_user(row: &Row<'_>) -> rusqlite::Result<User> {
    Ok(User {
        id: row.get("id")?,
        username: row.get("username")?,
        primary_address: row.get("primary_address")?,
        password_hash: row.get("password_hash")?,
        created_at: row.get("created_at")?,
        password_changed_at: row.get("password_changed_at")?,
        setup_token_hash: row.get("setup_token_hash")?,
        setup_token_expires_at: row.get("setup_token_expires_at")?,
        setup_completed_at: row.get("setup_completed_at")?,
    })
}

const SESSION_COLUMNS: &str =
    "id, user_id, token_hash, csrf_token, created_at, last_used_at, expires_at, revoked_at";

fn row_to_session(row: &Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get("id")?,
        user_id: row.get("user_id")?,
        token_hash: row.get("token_hash")?,
        csrf_token: row.get("csrf_token")?,
        created_at: row.get("created_at")?,
        last_used_at: row.get("last_used_at")?,
        expires_at: row.get("expires_at")?,
        revoked_at: row.get("revoked_at")?,
    })
}

fn row_to_passkey(row: &Row<'_>) -> rusqlite::Result<PasskeyRecord> {
    Ok(PasskeyRecord {
        id: row.get("id")?,
        user_id: row.get("user_id")?,
        name: row.get("name")?,
        credential: row.get("credential")?,
        created_at: row.get("created_at")?,
        last_used_at: row.get("last_used_at")?,
    })
}

const TOKEN_COLUMNS: &str = "id, name, token_hash, scopes, created_at, expires_at, revoked_at, \
     last_used_at, prefix, user_id";

fn row_to_token(row: &Row<'_>) -> rusqlite::Result<ApiToken> {
    let scopes_text: String = row.get("scopes")?;
    let scopes = ScopeSet::from_storage(&scopes_text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Text,
            Box::new(StoreError::Corrupt(error.to_string())),
        )
    })?;
    Ok(ApiToken {
        id: row.get("id")?,
        user_id: row
            .get::<_, Option<UserId>>("user_id")?
            .unwrap_or_else(UserId::new),
        name: row.get("name")?,
        prefix: row.get::<_, Option<String>>("prefix")?.unwrap_or_default(),
        scopes,
        created_at: row.get("created_at")?,
        expires_at: row.get("expires_at")?,
        revoked_at: row.get("revoked_at")?,
        last_used_at: row.get("last_used_at")?,
        token_hash: row.get("token_hash")?,
    })
}

fn route_to_str(route: Route) -> &'static str {
    match route {
        Route::Inbox => "inbox",
        Route::Spam => "spam",
        Route::Quarantine => "quarantine",
    }
}

fn route_from_str(value: &str) -> rusqlite::Result<Route> {
    match value {
        "inbox" => Ok(Route::Inbox),
        "spam" => Ok(Route::Spam),
        "quarantine" => Ok(Route::Quarantine),
        other => Err(rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            Box::new(StoreError::Corrupt(format!("unknown route: {other}"))),
        )),
    }
}

fn quarantine_status_to_str(status: QuarantineStatus) -> &'static str {
    match status {
        QuarantineStatus::Quarantined => "quarantined",
        QuarantineStatus::Recovering => "recovering",
        QuarantineStatus::Recovered => "recovered",
        QuarantineStatus::Deleting => "deleting",
        QuarantineStatus::Deleted => "deleted",
    }
}

fn quarantine_status_from_str(value: &str) -> rusqlite::Result<QuarantineStatus> {
    match value {
        "quarantined" => Ok(QuarantineStatus::Quarantined),
        "recovering" => Ok(QuarantineStatus::Recovering),
        "recovered" => Ok(QuarantineStatus::Recovered),
        "deleting" => Ok(QuarantineStatus::Deleting),
        "deleted" => Ok(QuarantineStatus::Deleted),
        other => Err(rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            Box::new(StoreError::Corrupt(format!(
                "unknown quarantine status: {other}"
            ))),
        )),
    }
}

fn quarantine_kind_to_str(kind: QuarantineKind) -> &'static str {
    match kind {
        QuarantineKind::Lease => "lease",
        QuarantineKind::Spam => "spam",
    }
}

fn quarantine_kind_from_str(value: &str) -> rusqlite::Result<QuarantineKind> {
    match value {
        "lease" => Ok(QuarantineKind::Lease),
        "spam" => Ok(QuarantineKind::Spam),
        other => Err(rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            Box::new(StoreError::Corrupt(format!(
                "unknown quarantine kind: {other}"
            ))),
        )),
    }
}

const QUARANTINE_COLUMNS: &str = "message_id, status, kind, sender, subject, received_at, \
     quarantine_expires_at, mailbox, uidvalidity, uid, size_bytes, idempotency_key, \
     delete_reason, created_at, updated_at, recovered_at, deleted_at";

fn row_to_quarantine(row: &Row<'_>) -> rusqlite::Result<QuarantineMetadata> {
    let status_text: String = row.get("status")?;
    let kind_text: String = row.get("kind")?;
    let mailbox: Option<String> = row.get("mailbox")?;
    let uidvalidity: Option<u32> = row.get("uidvalidity")?;
    let uid: Option<u32> = row.get("uid")?;
    let locator = mailbox.map(|mailbox| MailboxLocator {
        mailbox,
        uidvalidity: uidvalidity.unwrap_or(0),
        uid: uid.unwrap_or(0),
    });
    Ok(QuarantineMetadata {
        message_id: row.get("message_id")?,
        kind: quarantine_kind_from_str(&kind_text)?,
        status: quarantine_status_from_str(&status_text)?,
        alias_ids: Vec::new(),
        sender: row.get("sender")?,
        subject: row.get("subject")?,
        received_at: row.get("received_at")?,
        quarantine_expires_at: row.get("quarantine_expires_at")?,
        locator,
        size_bytes: row.get::<_, i64>("size_bytes")? as u64,
        idempotency_key: row.get("idempotency_key")?,
        delete_reason: row.get("delete_reason")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        recovered_at: row.get("recovered_at")?,
        deleted_at: row.get("deleted_at")?,
    })
}

const ALIAS_COLUMNS: &str = "id, address, label, purpose, created_at, expires_at, disabled_at, \
     lease_duration_seconds, renew_on_outbound, last_inbound_at, last_user_activity_at, \
     policy_version";

fn row_to_alias(row: &Row<'_>) -> rusqlite::Result<Alias> {
    Ok(Alias {
        id: row.get("id")?,
        address: row.get("address")?,
        label: row.get("label")?,
        purpose: row.get("purpose")?,
        created_at: row.get("created_at")?,
        expires_at: row.get("expires_at")?,
        disabled_at: row.get("disabled_at")?,
        lease_duration_seconds: row.get("lease_duration_seconds")?,
        renew_on_outbound: row.get("renew_on_outbound")?,
        last_inbound_at: row.get("last_inbound_at")?,
        last_user_activity_at: row.get("last_user_activity_at")?,
        policy_version: row.get("policy_version")?,
    })
}

fn audit_kind_to_str(kind: AuditEventKind) -> &'static str {
    match kind {
        AuditEventKind::Created => "created",
        AuditEventKind::RenewedByOutbound => "renewed_by_outbound",
        AuditEventKind::ManuallyRenewed => "manually_renewed",
        AuditEventKind::ManuallyExtended => "manually_extended",
        AuditEventKind::ExpirySet => "expiry_set",
        AuditEventKind::ExpiryRemoved => "expiry_removed",
        AuditEventKind::Expired => "expired",
        AuditEventKind::Recovered => "recovered",
        AuditEventKind::RepliedAsAlias => "replied_as_alias",
        AuditEventKind::Disabled => "disabled",
        AuditEventKind::Enabled => "enabled",
    }
}

fn audit_kind_from_str(value: &str) -> rusqlite::Result<AuditEventKind> {
    match value {
        "created" => Ok(AuditEventKind::Created),
        "renewed_by_outbound" => Ok(AuditEventKind::RenewedByOutbound),
        "manually_renewed" => Ok(AuditEventKind::ManuallyRenewed),
        "manually_extended" => Ok(AuditEventKind::ManuallyExtended),
        "expiry_set" => Ok(AuditEventKind::ExpirySet),
        "expiry_removed" => Ok(AuditEventKind::ExpiryRemoved),
        "expired" => Ok(AuditEventKind::Expired),
        "recovered" => Ok(AuditEventKind::Recovered),
        "replied_as_alias" => Ok(AuditEventKind::RepliedAsAlias),
        "disabled" => Ok(AuditEventKind::Disabled),
        "enabled" => Ok(AuditEventKind::Enabled),
        other => Err(rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            Box::new(StoreError::Corrupt(format!("unknown audit kind: {other}"))),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{Store, StoreError, latest_version};
    use crate::address::CanonicalAddress;
    use crate::alias::{Alias, AliasId, DEFAULT_LEASE_SECONDS};
    use crate::audit::{AuditDetail, AuditEvent, AuditEventKind};
    use crate::mail::store::MailboxLocator;
    use crate::message::{Message, MessageId, Route};
    use crate::quarantine::{QuarantineKind, QuarantineMetadata, QuarantineStatus};
    use crate::timestamp::Timestamp;

    fn at(value: &str) -> Timestamp {
        value.parse().unwrap()
    }

    fn alias(id: &str, address: &str) -> Alias {
        Alias {
            id: AliasId::from_uuid(id.parse().unwrap()),
            address: CanonicalAddress::parse(address).unwrap(),
            label: Some("Example".to_string()),
            purpose: None,
            created_at: at("2026-01-01T00:00:00Z"),
            expires_at: Some(at("2026-01-08T00:00:00Z")),
            disabled_at: None,
            lease_duration_seconds: DEFAULT_LEASE_SECONDS,
            renew_on_outbound: true,
            last_inbound_at: None,
            last_user_activity_at: None,
            policy_version: 0,
        }
    }

    fn table_exists(store: &Store, name: &str) -> bool {
        store
            .connection()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                rusqlite::params![name],
                |row| row.get::<_, bool>(0),
            )
            .unwrap()
    }

    /// Tables created by the schema, in migration order.
    const SCHEMA_TABLES: &[&str] = &[
        "aliases",
        "policy",
        "messages",
        "message_aliases",
        "quarantine_metadata",
        "audit_events",
        "api_tokens",
        "users",
        "sessions",
        "recovery_codes",
        "passkeys",
        "mail_credentials",
        "idempotency_keys",
    ];

    #[test]
    fn migrates_forward_and_reverts_cleanly() {
        let mut store = Store::open_in_memory().unwrap();
        assert_eq!(store.schema_version().unwrap(), 0);

        store.migrate().unwrap();
        assert_eq!(store.schema_version().unwrap(), latest_version());
        for table in SCHEMA_TABLES {
            assert!(table_exists(&store, table), "missing table {table}");
        }

        store.migrate_to(0).unwrap();
        assert_eq!(store.schema_version().unwrap(), 0);
        for table in SCHEMA_TABLES {
            assert!(
                !table_exists(&store, table),
                "table {table} survived revert"
            );
        }

        // Re-applying after a revert is idempotent and clean.
        store.migrate().unwrap();
        assert_eq!(store.schema_version().unwrap(), latest_version());
    }

    #[test]
    fn reverting_preserves_earlier_data() {
        let mut store = Store::open_in_memory().unwrap();
        store.migrate_to(1).unwrap();
        store
            .insert_alias(&alias(
                "018f9b60-0000-7000-8000-000000000001",
                "green.farm@example.com",
            ))
            .unwrap();

        // Apply later migrations on top of production-shaped data.
        store.migrate().unwrap();
        assert!(
            store
                .get_alias_by_address(&CanonicalAddress::parse("green.farm@example.com").unwrap())
                .unwrap()
                .is_some()
        );

        // Reverting later migrations leaves the alias table intact.
        store.migrate_to(1).unwrap();
        assert!(
            store
                .get_alias_by_address(&CanonicalAddress::parse("green.farm@example.com").unwrap())
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn rejects_unknown_migration_target() {
        let mut store = Store::open_in_memory().unwrap();
        assert!(matches!(
            store.migrate_to(latest_version() + 1),
            Err(StoreError::UnknownMigration(_))
        ));
        assert!(matches!(
            store.migrate_to(-1),
            Err(StoreError::UnknownMigration(_))
        ));
    }

    #[test]
    fn file_database_uses_write_ahead_logging() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wickmail.sqlite");
        let store = Store::open(&path).unwrap();
        let mode: String = store
            .connection()
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let foreign_keys: bool = store
            .connection()
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert!(foreign_keys);
    }

    #[test]
    fn enforces_address_uniqueness_on_canonical_form() {
        let mut store = Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        store
            .insert_alias(&alias(
                "018f9b60-0000-7000-8000-000000000001",
                "green.farm@example.com",
            ))
            .unwrap();
        let duplicate = alias(
            "018f9b60-0000-7000-8000-000000000002",
            "Green.Farm@Example.COM",
        );
        assert!(store.insert_alias(&duplicate).is_err());
    }

    #[test]
    fn enforces_foreign_keys() {
        let mut store = Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        let result = store.connection().execute(
            "INSERT INTO message_aliases (message_id, alias_id) VALUES (?1, ?2)",
            rusqlite::params![
                "018f9b60-0000-7000-8000-0000000000aa",
                "018f9b60-0000-7000-8000-0000000000bb"
            ],
        );
        assert!(result.is_err());
    }

    #[test]
    fn updates_use_optimistic_concurrency() {
        let mut store = Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        let mut value = alias(
            "018f9b60-0000-7000-8000-000000000001",
            "green.farm@example.com",
        );
        store.insert_alias(&value).unwrap();

        value.policy_version = 1;
        value.label = Some("Renamed".to_string());
        store.update_alias(&value).unwrap();

        // A stale write with the same target version is rejected.
        let stale = value.clone();
        assert!(matches!(
            store.update_alias(&stale),
            Err(StoreError::VersionConflict(_))
        ));
    }

    #[test]
    fn audit_events_round_trip() {
        let mut store = Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        let value = alias(
            "018f9b60-0000-7000-8000-000000000001",
            "green.farm@example.com",
        );
        store.insert_alias(&value).unwrap();

        let event = AuditEvent::new(
            value.id,
            AuditEventKind::RenewedByOutbound,
            Some(AuditDetail {
                previous_expires_at: Some(at("2026-01-08T00:00:00Z")),
                expires_at: Some(at("2026-01-15T00:00:00Z")),
                lease_seconds: Some(DEFAULT_LEASE_SECONDS),
                message_id: None,
            }),
            at("2026-01-04T00:00:00Z"),
        );
        store.insert_audit_event(&event).unwrap();

        let events = store.list_audit_events(value.id).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, AuditEventKind::RenewedByOutbound);
        assert_eq!(
            events[0].detail.as_ref().unwrap().lease_seconds,
            Some(DEFAULT_LEASE_SECONDS)
        );
    }

    #[test]
    fn quarantine_metadata_round_trips_and_purges() {
        let mut store = Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        let value = alias(
            "018f9b60-0000-7000-8000-000000000001",
            "green.farm@example.com",
        );
        store.insert_alias(&value).unwrap();
        let message = Message {
            id: MessageId::new(),
            alias_ids: vec![value.id],
            primary_received: false,
            sender: "sender@example.com".to_string(),
            subject: "hello".to_string(),
            received_at: at("2026-01-01T00:00:00Z"),
            route: Route::Quarantine,
        };
        store.ensure_message(&message).unwrap();
        store
            .connection()
            .execute(
                "INSERT INTO message_aliases (message_id, alias_id) VALUES (?1, ?2)",
                rusqlite::params![message.id, value.id],
            )
            .unwrap();

        let metadata = QuarantineMetadata {
            message_id: message.id,
            kind: QuarantineKind::Lease,
            status: QuarantineStatus::Quarantined,
            alias_ids: vec![value.id],
            sender: message.sender.clone(),
            subject: message.subject.clone(),
            received_at: message.received_at,
            quarantine_expires_at: at("2026-01-31T00:00:00Z"),
            locator: Some(MailboxLocator {
                mailbox: "Aliases/Expired".to_string(),
                uidvalidity: 1,
                uid: 2,
            }),
            size_bytes: 123,
            idempotency_key: None,
            delete_reason: None,
            created_at: at("2026-01-01T00:00:00Z"),
            updated_at: at("2026-01-01T00:00:00Z"),
            recovered_at: None,
            deleted_at: None,
        };
        store.upsert_quarantine_metadata(&metadata).unwrap();
        let loaded = store.get_quarantine_metadata(message.id).unwrap().unwrap();
        assert_eq!(loaded, metadata);
        assert_eq!(loaded.alias_ids, vec![value.id]);

        // Insert-if-absent leaves the existing row untouched.
        let mut changed = metadata.clone();
        changed.status = QuarantineStatus::Recovered;
        store.insert_quarantine_metadata(&changed).unwrap();
        assert_eq!(
            store
                .get_quarantine_metadata(message.id)
                .unwrap()
                .unwrap()
                .status,
            QuarantineStatus::Quarantined
        );

        // Upsert replaces.
        store.upsert_quarantine_metadata(&changed).unwrap();
        assert_eq!(
            store
                .get_quarantine_metadata(message.id)
                .unwrap()
                .unwrap()
                .status,
            QuarantineStatus::Recovered
        );

        // Purge removes only deleted rows at or before the cutoff.
        let mut deleted = changed.clone();
        deleted.status = QuarantineStatus::Deleted;
        deleted.deleted_at = Some(at("2026-01-02T00:00:00Z"));
        store.upsert_quarantine_metadata(&deleted).unwrap();
        assert_eq!(
            store
                .purge_deleted_quarantine_metadata(at("2026-01-01T00:00:00Z"))
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .purge_deleted_quarantine_metadata(at("2026-01-03T00:00:00Z"))
                .unwrap(),
            1
        );
        assert!(store.get_quarantine_metadata(message.id).unwrap().is_none());
    }
}
