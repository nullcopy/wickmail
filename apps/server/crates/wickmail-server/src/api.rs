//! Management API request and response shapes.
//!
//! The Rust server is the source of truth for the HTTP contract. These types
//! are serialized to JSON with camelCase field names; the TypeScript client in
//! `packages/core` mirrors them, and drift is guarded by the fixtures in
//! `contract`.

use serde::{Deserialize, Serialize};

use crate::address::CanonicalAddress;
use crate::alias::{Alias, AliasId, AliasState};
use crate::audit::{AuditDetail, AuditEvent, AuditEventId, AuditEventKind};
use crate::lease::evaluate_state;
use crate::message::{MessageId, Provenance, ReplyIdentity};
use crate::timestamp::Timestamp;

/// Version of the management API contract.
pub const API_CONTRACT_VERSION: &str = "1.0.0";

/// Body of `POST /v1/aliases`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAliasRequest {
    /// User-facing name.
    pub label: Option<String>,
    /// Optional order, merchant, or notes field.
    pub purpose: Option<String>,
    /// Lease or absolute expiration; omitted means the default lease.
    pub expiry: Option<ExpiryRequest>,
    /// Whether authenticated outbound mail renews the lease.
    pub renew_on_outbound: Option<bool>,
}

/// Initial expiration setting for a new alias.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExpiryRequest {
    /// Start with a lease relative to creation.
    Lease {
        /// Lease duration in seconds; omitted means the server default.
        seconds: Option<i64>,
    },
    /// Start with an absolute expiry.
    Absolute {
        /// Absolute expiry in UTC.
        expires_at: Timestamp,
    },
    /// Start with no expiry.
    Never,
}

/// Body of `PATCH /v1/aliases/{id}`.
///
/// These edits never update `last_user_activity_at`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAliasRequest {
    /// New label.
    pub label: Option<String>,
    /// New purpose.
    pub purpose: Option<String>,
    /// New outbound renewal policy.
    pub renew_on_outbound: Option<bool>,
}

/// Body of `POST /v1/aliases/{id}/renew` and `/extend`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurationRequest {
    /// Duration in seconds; omitted means `lease_duration`.
    pub seconds: Option<i64>,
}

/// Body of `POST /v1/aliases/{id}/expiry`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetExpiryRequest {
    /// Absolute expiry in UTC.
    pub expires_at: Timestamp,
}

/// Body of `POST /v1/aliases/{id}/enable`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnableRequest {
    /// Optional explicit expiry; omitted means `now + lease_duration`.
    pub expires_at: Option<Timestamp>,
}

/// An alias as returned by the management API.
///
/// Clients consume the server-computed `state` and raw timestamps; they never
/// derive lease state themselves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasResponse {
    /// Stable internal identifier.
    pub id: AliasId,
    /// Canonical full address.
    pub address: CanonicalAddress,
    /// User-facing name.
    pub label: Option<String>,
    /// Optional order, merchant, or notes field.
    pub purpose: Option<String>,
    /// Server-computed lifecycle state.
    pub state: AliasState,
    /// Creation timestamp.
    pub created_at: Timestamp,
    /// Absolute expiry, or `null`.
    pub expires_at: Option<Timestamp>,
    /// When disabled, or `null`.
    pub disabled_at: Option<Timestamp>,
    /// Renewal duration in seconds.
    pub lease_seconds: i64,
    /// Whether authenticated outbound mail renews the lease.
    pub renew_on_outbound: bool,
    /// Most recent accepted inbound mail, or `null`.
    pub last_inbound_at: Option<Timestamp>,
    /// Most recent user activity, or `null`.
    pub last_user_activity_at: Option<Timestamp>,
    /// Server-computed last-used time for sorting.
    pub last_used_at: Timestamp,
    /// Optimistic concurrency version.
    pub policy_version: i64,
}

impl AliasResponse {
    /// Builds the API view of `alias` evaluated at `now`.
    pub fn from_alias(alias: &Alias, now: Timestamp) -> Self {
        Self {
            id: alias.id,
            address: alias.address.clone(),
            label: alias.label.clone(),
            purpose: alias.purpose.clone(),
            state: evaluate_state(alias, now),
            created_at: alias.created_at,
            expires_at: alias.expires_at,
            disabled_at: alias.disabled_at,
            lease_seconds: alias.lease_duration_seconds,
            renew_on_outbound: alias.renew_on_outbound,
            last_inbound_at: alias.last_inbound_at,
            last_user_activity_at: alias.last_user_activity_at,
            last_used_at: alias.last_used_at(),
            policy_version: alias.policy_version,
        }
    }
}

/// Response of `GET /v1/aliases`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasListResponse {
    /// The page of aliases.
    pub items: Vec<AliasResponse>,
    /// Cursor for the next page, or `null`.
    pub next_cursor: Option<String>,
}

/// An audit event as returned by `GET /v1/aliases/{id}/events`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasEventResponse {
    /// Stable event identifier.
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

impl From<AuditEvent> for AliasEventResponse {
    fn from(event: AuditEvent) -> Self {
        Self {
            id: event.id,
            alias_id: event.alias_id,
            kind: event.kind,
            created_at: event.created_at,
            detail: event.detail,
        }
    }
}

/// Trusted provenance as returned by the reply-context endpoint.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceResponse {
    /// Aliases that received the message.
    pub alias_ids: Vec<AliasId>,
    /// Whether the primary address received the message.
    pub primary_received: bool,
    /// Default reply identity for this provenance.
    pub reply_identity: ReplyIdentity,
}

impl From<Provenance> for ProvenanceResponse {
    fn from(provenance: Provenance) -> Self {
        let reply_identity = provenance.reply_identity();
        Self {
            alias_ids: provenance.alias_ids,
            primary_received: provenance.primary_received,
            reply_identity,
        }
    }
}

/// Response of `GET /v1/messages/{id}/reply-context`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyContextResponse {
    /// Stable message identity.
    pub message_id: MessageId,
    /// Sanitized sender.
    pub from: String,
    /// Subject line.
    pub subject: String,
    /// Plain-text body for quoting.
    pub text: String,
    /// Trusted provenance.
    pub provenance: ProvenanceResponse,
}

/// Body of `POST /v1/messages/{id}/reply`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyRequest {
    /// Alias to send as.
    pub alias_id: AliasId,
    /// Message body.
    pub body: String,
    /// Optional quoted text.
    pub quoted_text: Option<String>,
}

/// Response of `POST /v1/messages/{id}/reply`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyResponse {
    /// Whether the message was queued for submission.
    pub queued: bool,
    /// Identity assigned to the queued message.
    pub message_id: MessageId,
}

/// Error envelope returned for failed requests.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResponse {
    /// Stable machine-readable error code.
    pub code: String,
    /// Human-readable message.
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::{AliasResponse, CreateAliasRequest, ExpiryRequest, UpdateAliasRequest};
    use crate::address::CanonicalAddress;
    use crate::alias::{Alias, AliasId, AliasState, DEFAULT_LEASE_SECONDS};
    use crate::timestamp::Timestamp;

    fn alias() -> Alias {
        Alias {
            id: AliasId::from_uuid("018f9b60-0000-7000-8000-000000000000".parse().unwrap()),
            address: CanonicalAddress::parse("green.farm@example.com").unwrap(),
            label: Some("Example Store".to_string()),
            purpose: None,
            created_at: "2026-01-01T00:00:00Z".parse().unwrap(),
            expires_at: Some("2026-01-08T00:00:00Z".parse().unwrap()),
            disabled_at: None,
            lease_duration_seconds: DEFAULT_LEASE_SECONDS,
            renew_on_outbound: true,
            last_inbound_at: None,
            last_user_activity_at: None,
            policy_version: 3,
        }
    }

    #[test]
    fn alias_response_uses_camel_case_and_computed_state() {
        let response = AliasResponse::from_alias(
            &alias(),
            "2026-01-04T00:00:00Z".parse::<Timestamp>().unwrap(),
        );
        let json = serde_json::to_value(&response).unwrap();
        assert_eq!(json["address"], "green.farm@example.com");
        assert_eq!(json["state"], "active");
        assert_eq!(json["leaseSeconds"], DEFAULT_LEASE_SECONDS);
        assert_eq!(json["renewOnOutbound"], true);
        assert_eq!(json["policyVersion"], 3);
        assert_eq!(json["lastUsedAt"], "2026-01-01T00:00:00Z");
    }

    #[test]
    fn expired_alias_reports_expired_state() {
        let response = AliasResponse::from_alias(
            &alias(),
            "2026-02-01T00:00:00Z".parse::<Timestamp>().unwrap(),
        );
        assert_eq!(response.state, AliasState::Expired);
    }

    #[test]
    fn create_alias_request_round_trips() {
        let request = CreateAliasRequest {
            label: Some("Example Store".to_string()),
            purpose: None,
            expiry: Some(ExpiryRequest::Lease {
                seconds: Some(86_400),
            }),
            renew_on_outbound: Some(true),
        };
        let json = serde_json::to_string(&request).unwrap();
        let decoded: CreateAliasRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, request);
        assert!(json.contains("\"mode\":\"lease\""));
        assert!(json.contains("\"seconds\":86400"));
    }

    #[test]
    fn absent_optional_fields_deserialize_to_none() {
        let request: UpdateAliasRequest = serde_json::from_str("{}").unwrap();
        assert_eq!(request, UpdateAliasRequest::default());
    }
}
