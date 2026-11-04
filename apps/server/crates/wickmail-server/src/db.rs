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
use crate::message::{Message, MessageId, Route};

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
    /// Stored data could not be decoded.
    #[error("invalid stored data: {0}")]
    Corrupt(String),
}

/// A single-owner connection to the Wickmail database.
pub struct Store {
    connection: Connection,
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
    use super::{MIGRATIONS, Store, StoreError, latest_version};
    use crate::address::CanonicalAddress;
    use crate::alias::{Alias, AliasId, DEFAULT_LEASE_SECONDS};
    use crate::audit::{AuditDetail, AuditEvent, AuditEventKind};
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

    #[test]
    fn migrates_forward_and_reverts_cleanly() {
        let mut store = Store::open_in_memory().unwrap();
        assert_eq!(store.schema_version().unwrap(), 0);

        store.migrate().unwrap();
        assert_eq!(store.schema_version().unwrap(), latest_version());
        for migration in MIGRATIONS {
            assert!(
                table_exists(&store, migration.name),
                "missing table for migration {}",
                migration.name
            );
        }

        store.migrate_to(0).unwrap();
        assert_eq!(store.schema_version().unwrap(), 0);
        for migration in MIGRATIONS {
            assert!(
                !table_exists(&store, migration.name),
                "table {} survived revert",
                migration.name
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
}
