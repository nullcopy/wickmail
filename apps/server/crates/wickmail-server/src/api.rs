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
use crate::identity::{SessionId, UserId};
use crate::lease::evaluate_state;
use crate::message::{MessageId, Provenance};
use crate::timestamp::Timestamp;

/// Version of the management API contract.
pub const API_CONTRACT_VERSION: &str = "1.2.0";

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
}

impl From<Provenance> for ProvenanceResponse {
    fn from(provenance: Provenance) -> Self {
        Self {
            alias_ids: provenance.alias_ids,
            primary_received: provenance.primary_received,
        }
    }
}

/// How the default reply identity was chosen.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplyIdentitySelection {
    /// The server selected a default identity.
    Default,
    /// Several aliases received the message; the client must prompt.
    Prompt,
}

/// A concrete reply sending identity.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ReplyIdentityOption {
    /// An owned alias that received the message.
    Alias {
        /// The alias identity.
        alias_id: AliasId,
        /// The alias's canonical address.
        address: CanonicalAddress,
    },
    /// The account's primary address.
    Primary {
        /// The primary canonical address.
        address: CanonicalAddress,
    },
}

impl ReplyIdentityOption {
    /// The sending address for this identity.
    pub fn address(&self) -> &CanonicalAddress {
        match self {
            Self::Alias { address, .. } | Self::Primary { address } => address,
        }
    }

    /// The alias identity, when this option is an alias.
    pub fn alias_id(&self) -> Option<AliasId> {
        match self {
            Self::Alias { alias_id, .. } => Some(*alias_id),
            Self::Primary { .. } => None,
        }
    }
}

/// The reply-identity decision for a message's trusted provenance.
///
/// `selected` is the default identity, or `None` when the client must prompt.
/// `options` are the identities the client may offer, in preference order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyIdentityDecision {
    /// Whether a default was selected or the client must prompt.
    pub selection: ReplyIdentitySelection,
    /// The default identity, or `None` when the client must prompt.
    pub selected: Option<ReplyIdentityOption>,
    /// The identities the client may offer, in preference order.
    pub options: Vec<ReplyIdentityOption>,
}

/// Response of `GET /v1/messages/{id}/reply-context`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyContextResponse {
    /// Stable message identity.
    pub message_id: MessageId,
    /// Sanitized sender, or `None` when it cannot be determined.
    pub from: Option<String>,
    /// Sanitized subject, or `None` when absent.
    pub subject: Option<String>,
    /// Sanitized plain-text body for quoting.
    pub text: String,
    /// The original RFC 5322 `Message-ID`, for threading, or `None`.
    pub original_message_id: Option<String>,
    /// Trusted provenance.
    pub provenance: ProvenanceResponse,
    /// The reply-identity decision derived from provenance and ownership.
    pub identity: ReplyIdentityDecision,
}

/// Body of `POST /v1/messages/{id}/reply`.
///
/// `alias_id` selects an owned alias that received the message; omitting it
/// uses the default identity from provenance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyRequest {
    /// Alias to send as, or `None` for the default identity.
    pub alias_id: Option<AliasId>,
    /// Message body.
    pub body: String,
    /// Optional quoted text.
    pub quoted_text: Option<String>,
}

/// Response of `POST /v1/messages/{id}/reply`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyResponse {
    /// Whether the message was queued for submission.
    pub queued: bool,
    /// Identity assigned to the queued message.
    pub message_id: MessageId,
    /// The identity the reply was sent as.
    pub identity: ReplyIdentityOption,
    /// Whether the submission renewed the alias lease.
    pub renewed: bool,
    /// The resulting absolute expiry, or `None` for no expiry.
    pub expires_at: Option<Timestamp>,
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

/// The management user as returned by the API. Secrets are never included.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserResponse {
    /// Stable identifier.
    pub id: UserId,
    /// Informational login name.
    pub username: String,
    /// The account's primary address.
    pub primary_address: String,
    /// When the user was created.
    pub created_at: Timestamp,
    /// Whether first-run setup has completed.
    pub setup_completed: bool,
    /// When the password last changed, or `null`.
    pub password_changed_at: Option<Timestamp>,
}

impl From<crate::identity::User> for UserResponse {
    fn from(user: crate::identity::User) -> Self {
        Self {
            setup_completed: !user.setup_pending(),
            id: user.id,
            username: user.username,
            primary_address: user.primary_address,
            created_at: user.created_at,
            password_changed_at: user.password_changed_at,
        }
    }
}

/// Body of `POST /v1/setup`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupRequest {
    /// The single-use setup token printed by the bootstrap CLI.
    pub setup_token: String,
    /// The management password to set.
    pub password: String,
}

/// Response of `POST /v1/setup`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupResponse {
    /// The configured user.
    pub user: UserResponse,
}

/// Body of `POST /v1/sessions`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    /// The management password.
    pub password: String,
}

/// A management session as returned by the API.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// Stable session identifier.
    pub id: SessionId,
    /// When the session was created.
    pub created_at: Timestamp,
    /// Most recent authenticated use.
    pub last_used_at: Timestamp,
    /// When the session expires.
    pub expires_at: Timestamp,
}

impl From<crate::identity::Session> for SessionInfo {
    fn from(session: crate::identity::Session) -> Self {
        Self {
            id: session.id,
            created_at: session.created_at,
            last_used_at: session.last_used_at,
            expires_at: session.expires_at,
        }
    }
}

/// Response of `POST /v1/sessions` and `GET /v1/session`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    /// The session.
    pub session: SessionInfo,
    /// CSRF token the client must echo on cookie-authenticated mutations.
    pub csrf_token: String,
}

/// Body of `POST /v1/recovery`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverRequest {
    /// A one-time recovery code.
    pub code: String,
    /// The new management password.
    pub password: String,
}

/// The mail credential as returned by the API.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailCredentialResponse {
    /// Whether a usable mail password is set.
    pub configured: bool,
    /// When the credential was first set, or `null`.
    pub created_at: Option<Timestamp>,
    /// When the credential was last rotated, or `null`.
    pub rotated_at: Option<Timestamp>,
    /// When the credential was revoked, or `null`.
    pub revoked_at: Option<Timestamp>,
}

impl From<crate::identity::MailCredential> for MailCredentialResponse {
    fn from(credential: crate::identity::MailCredential) -> Self {
        Self {
            configured: credential.is_configured(),
            created_at: Some(credential.created_at),
            rotated_at: credential.rotated_at,
            revoked_at: credential.revoked_at,
        }
    }
}

/// Body of `POST /v1/mail-credential`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RotateMailCredentialRequest {
    /// Password to set; omitted means the server generates one.
    pub password: Option<String>,
}

/// Response of `POST /v1/mail-credential`. The password is shown once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RotateMailCredentialResponse {
    /// The new credential status.
    pub credential: MailCredentialResponse,
    /// The plaintext password, shown exactly once.
    pub password: String,
}

/// Body of `POST /v1/tokens`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTokenRequest {
    /// User-facing name.
    pub name: String,
    /// Granted scopes.
    pub scopes: Vec<crate::token::Scope>,
    /// Absolute expiry, or `None` for no expiry.
    pub expires_at: Option<Timestamp>,
}

/// An API token as returned by the API. The secret is never included.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiTokenResponse {
    /// Stable identifier.
    pub id: crate::token::TokenId,
    /// User-facing name.
    pub name: String,
    /// Non-secret display prefix.
    pub prefix: String,
    /// Granted scopes.
    pub scopes: crate::token::ScopeSet,
    /// When the token was created.
    pub created_at: Timestamp,
    /// Absolute expiry, or `null`.
    pub expires_at: Option<Timestamp>,
    /// When the token was revoked, or `null`.
    pub revoked_at: Option<Timestamp>,
    /// Most recent authenticated use, or `null`.
    pub last_used_at: Option<Timestamp>,
}

impl From<crate::token::ApiToken> for ApiTokenResponse {
    fn from(token: crate::token::ApiToken) -> Self {
        Self {
            id: token.id,
            name: token.name,
            prefix: token.prefix,
            scopes: token.scopes,
            created_at: token.created_at,
            expires_at: token.expires_at,
            revoked_at: token.revoked_at,
            last_used_at: token.last_used_at,
        }
    }
}

/// Response of `POST /v1/tokens`. The token is shown exactly once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedTokenResponse {
    /// The plaintext token, shown exactly once.
    pub token: String,
    /// The stored token metadata.
    pub record: ApiTokenResponse,
}

/// Response of `GET /v1/tokens`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenListResponse {
    /// The tokens.
    pub items: Vec<ApiTokenResponse>,
}

/// A quarantined message as returned by the API.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineResponse {
    /// Stable message identity.
    pub message_id: MessageId,
    /// Lease quarantine or spam.
    pub kind: crate::quarantine::QuarantineKind,
    /// Current lifecycle status.
    pub status: crate::quarantine::QuarantineStatus,
    /// Aliases that received the message.
    pub alias_ids: Vec<AliasId>,
    /// Envelope sender.
    pub sender: String,
    /// Subject line.
    pub subject: String,
    /// When the message was accepted.
    pub received_at: Timestamp,
    /// When the retention window ends.
    pub quarantine_expires_at: Timestamp,
    /// Size of the stored body in bytes.
    pub size_bytes: u64,
    /// Why the message was deleted, or `null`.
    pub delete_reason: Option<String>,
    /// When the metadata row was created.
    pub created_at: Timestamp,
    /// When the metadata row was last updated.
    pub updated_at: Timestamp,
    /// When the message was recovered, or `null`.
    pub recovered_at: Option<Timestamp>,
    /// When the message was deleted, or `null`.
    pub deleted_at: Option<Timestamp>,
    /// Sanitized plain-text preview, only on the detail endpoint.
    pub preview: Option<String>,
}

impl QuarantineResponse {
    /// Builds the API view, optionally including a sanitized preview.
    pub fn from_metadata(
        metadata: crate::quarantine::QuarantineMetadata,
        preview: Option<String>,
    ) -> Self {
        Self {
            message_id: metadata.message_id,
            kind: metadata.kind,
            status: metadata.status,
            alias_ids: metadata.alias_ids,
            sender: metadata.sender,
            subject: metadata.subject,
            received_at: metadata.received_at,
            quarantine_expires_at: metadata.quarantine_expires_at,
            size_bytes: metadata.size_bytes,
            delete_reason: metadata.delete_reason,
            created_at: metadata.created_at,
            updated_at: metadata.updated_at,
            recovered_at: metadata.recovered_at,
            deleted_at: metadata.deleted_at,
            preview,
        }
    }
}

/// Response of `GET /v1/quarantine`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineListResponse {
    /// The page of quarantined messages.
    pub items: Vec<QuarantineResponse>,
    /// Cursor for the next page, or `null`.
    pub next_cursor: Option<String>,
}

/// Body of `POST /v1/quarantine/{id}/recover`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverQuarantineRequest {
    /// Renew the alias lease after recovery.
    pub renew: Option<bool>,
    /// Enable a disabled alias after recovery.
    pub enable: Option<bool>,
}

/// A registered passkey as returned by the API.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyResponse {
    /// Stable record identifier.
    pub id: String,
    /// User-facing name.
    pub name: String,
    /// When the passkey was registered.
    pub created_at: Timestamp,
    /// Most recent authentication, or `null`.
    pub last_used_at: Option<Timestamp>,
}

/// Response of `GET /v1/passkeys`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyListResponse {
    /// The registered passkeys.
    pub items: Vec<PasskeyResponse>,
}

impl From<crate::identity::PasskeyRecord> for PasskeyResponse {
    fn from(record: crate::identity::PasskeyRecord) -> Self {
        Self {
            id: record.id,
            name: record.name,
            created_at: record.created_at,
            last_used_at: record.last_used_at,
        }
    }
}

/// Response of a WebAuthn begin call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyChallengeResponse {
    /// Server-side state identifier paired with the challenge.
    pub state_id: String,
    /// The WebAuthn challenge, passed through to the browser unchanged.
    pub challenge: serde_json::Value,
}

/// Body of a WebAuthn finish call.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyFinishRequest {
    /// The state identifier from the begin call.
    pub state_id: String,
    /// The browser's WebAuthn response.
    pub credential: serde_json::Value,
    /// User-facing name for a new passkey.
    pub name: Option<String>,
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
