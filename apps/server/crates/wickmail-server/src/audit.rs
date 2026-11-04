//! Lifecycle audit events.
//!
//! Audit records describe policy changes and lifecycle transitions. They never
//! contain message bodies, and they are retained longer than delivery
//! metadata.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use time::Duration;
use uuid::Uuid;

use crate::alias::{Alias, AliasId, AliasState};
use crate::lease::evaluate_state;
use crate::message::MessageId;
use crate::timestamp::Timestamp;

/// How long delivery metadata is retained.
pub const DELIVERY_METADATA_RETENTION: Duration = Duration::days(30);

/// How long audit records are retained.
///
/// Audit retention outlives delivery metadata so the activity feed survives
/// after subjects and addresses are purged.
pub const AUDIT_RETENTION: Duration = Duration::days(365);

/// Stable identifier for an audit event.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AuditEventId(Uuid);

impl AuditEventId {
    /// Generates a new random identifier.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    /// Wraps an existing UUID.
    pub fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }

    /// The underlying UUID.
    pub fn as_uuid(self) -> Uuid {
        self.0
    }
}

impl Default for AuditEventId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for AuditEventId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for AuditEventId {
    type Err = uuid::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(value).map(Self)
    }
}

impl rusqlite::types::FromSql for AuditEventId {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        let text = value.as_str()?;
        AuditEventId::from_str(text)
            .map_err(|error| rusqlite::types::FromSqlError::Other(Box::new(error)))
    }
}

impl rusqlite::types::ToSql for AuditEventId {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        Ok(rusqlite::types::ToSqlOutput::from(self.0.to_string()))
    }
}

/// The lifecycle transition an audit event records.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditEventKind {
    /// The alias was created.
    Created,
    /// An authenticated outbound message renewed the lease.
    RenewedByOutbound,
    /// An explicit renew action.
    ManuallyRenewed,
    /// An explicit extend action.
    ManuallyExtended,
    /// An explicit set-expiry action.
    ExpirySet,
    /// An explicit remove-expiry action.
    ExpiryRemoved,
    /// The lease passed; derived from stored fields at read time.
    Expired,
    /// A quarantined message was recovered.
    Recovered,
    /// A reply was sent through the alias.
    RepliedAsAlias,
    /// The alias was disabled.
    Disabled,
    /// The alias was enabled.
    Enabled,
}

/// Structured detail attached to an audit event.
///
/// The fields are typed rather than free-form, which keeps message bodies out
/// of audit records by construction.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditDetail {
    /// Expiry before the action.
    pub previous_expires_at: Option<Timestamp>,
    /// Expiry after the action.
    pub expires_at: Option<Timestamp>,
    /// Lease duration applied, when the action used one.
    pub lease_seconds: Option<i64>,
    /// Related message, for recovery and reply events.
    pub message_id: Option<MessageId>,
}

/// A recorded lifecycle event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    /// Stable identifier.
    pub id: AuditEventId,
    /// The alias the event belongs to.
    pub alias_id: AliasId,
    /// The transition.
    pub kind: AuditEventKind,
    /// When the event was recorded.
    pub created_at: Timestamp,
    /// Structured detail.
    pub detail: Option<AuditDetail>,
}

impl AuditEvent {
    /// Records an event for `alias_id` at `created_at`.
    pub fn new(
        alias_id: AliasId,
        kind: AuditEventKind,
        detail: Option<AuditDetail>,
        created_at: Timestamp,
    ) -> Self {
        Self {
            id: AuditEventId::new(),
            alias_id,
            kind,
            created_at,
            detail,
        }
    }

    /// The instant this record may be purged.
    pub fn retained_until(&self) -> Option<Timestamp> {
        self.created_at.checked_add(AUDIT_RETENTION)
    }
}

/// Returns a derived expiration event when the alias is currently expired.
///
/// "Expired" is presentation state computed from `expires_at`; it is not a
/// persisted exactly-once event. A scheduler may later record a deduplicated
/// expiration event for notifications without changing this rule.
pub fn derived_expired_event(alias: &Alias, now: Timestamp) -> Option<AuditEvent> {
    if evaluate_state(alias, now) != AliasState::Expired {
        return None;
    }
    let expired_at = alias.expires_at?;
    Some(AuditEvent {
        id: AuditEventId::new(),
        alias_id: alias.id,
        kind: AuditEventKind::Expired,
        created_at: expired_at,
        detail: Some(AuditDetail {
            previous_expires_at: None,
            expires_at: Some(expired_at),
            lease_seconds: None,
            message_id: None,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        AUDIT_RETENTION, AuditEvent, AuditEventKind, DELIVERY_METADATA_RETENTION,
        derived_expired_event,
    };
    use crate::address::CanonicalAddress;
    use crate::alias::{Alias, AliasId, DEFAULT_LEASE_SECONDS};
    use crate::timestamp::Timestamp;

    fn alias() -> Alias {
        Alias {
            id: AliasId::from_uuid("018f9b60-0000-7000-8000-000000000000".parse().unwrap()),
            address: CanonicalAddress::parse("green.farm@example.com").unwrap(),
            label: None,
            purpose: None,
            created_at: "2026-01-01T00:00:00Z".parse().unwrap(),
            expires_at: Some("2026-01-08T00:00:00Z".parse().unwrap()),
            disabled_at: None,
            lease_duration_seconds: DEFAULT_LEASE_SECONDS,
            renew_on_outbound: true,
            last_inbound_at: None,
            last_user_activity_at: None,
            policy_version: 0,
        }
    }

    #[test]
    fn audit_retention_outlives_delivery_metadata() {
        assert!(AUDIT_RETENTION > DELIVERY_METADATA_RETENTION);
    }

    #[test]
    fn expired_state_yields_a_derived_event() {
        let now: Timestamp = "2026-02-01T00:00:00Z".parse().unwrap();
        let event = derived_expired_event(&alias(), now).expect("alias is expired");
        assert_eq!(event.kind, AuditEventKind::Expired);
        assert_eq!(
            event.created_at,
            "2026-01-08T00:00:00Z".parse::<Timestamp>().unwrap()
        );
    }

    #[test]
    fn active_state_yields_no_derived_event() {
        let now: Timestamp = "2026-01-02T00:00:00Z".parse().unwrap();
        assert!(derived_expired_event(&alias(), now).is_none());
    }

    #[test]
    fn audit_detail_serializes_without_message_content() {
        let event = AuditEvent::new(
            alias().id,
            AuditEventKind::Disabled,
            None,
            "2026-01-02T00:00:00Z".parse().unwrap(),
        );
        let json = serde_json::to_string(&event).unwrap();
        assert!(!json.contains("body"));
        assert!(!json.contains("text"));
        assert!(!json.contains("content"));
    }
}
