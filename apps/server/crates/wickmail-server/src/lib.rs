//! Core library for `wickmail-server`.
//!
//! This crate provides the alias domain model that every other component
//! depends on: readable random address generation and canonicalization, the
//! SQLite schema and versioned migrations, lease evaluation and the renewal
//! truth tables, and lifecycle audit events. The mail path, HTTP management
//! API, and clients build on these entry points.

pub mod abuse;
pub mod address;
pub mod alias;
pub mod api;
pub mod audit;
pub mod clock;
pub mod contract;
pub mod db;
pub mod generator;
pub mod http;
pub mod identity;
pub mod lease;
pub mod mail;
pub mod message;
pub mod quarantine;
pub mod reply;
pub mod service;
pub mod timestamp;
pub mod token;
pub mod wordlist;

pub use abuse::{
    AbusePolicy, AlertKind, Alerter, LogAlerter, RateLimit, RateLimited, RateLimiter,
    RecordingAlerter, is_disk_full,
};
pub use address::{AddressError, CanonicalAddress, Domain};
pub use alias::{Alias, AliasId, AliasState, DEFAULT_LEASE_SECONDS};
pub use api::{
    API_CONTRACT_VERSION, AliasResponse, CreateAliasRequest, ExpiryRequest, ReplyContextResponse,
    ReplyIdentityDecision, ReplyIdentityOption, ReplyIdentitySelection, ReplyRequest,
    ReplyResponse,
};
pub use audit::{
    AUDIT_RETENTION, AuditDetail, AuditEvent, AuditEventId, AuditEventKind,
    DELIVERY_METADATA_RETENTION, derived_expired_event,
};
pub use clock::{Clock, FixedClock, SharedClock, SystemClock};
pub use db::{MIGRATIONS, Migration, Store, StoreError, latest_version};
pub use generator::{AliasGenerator, GenerateError};
pub use http::{AppState, HttpConfig, HttpError, SameSite, router, serve_http};
pub use identity::{
    AuthError, IdentityService, MailCredential, PasskeyRecord, RecoveryCode, RecoveryCodeId,
    Session, SessionId, User, UserId, hash_password, hash_secret, verify_password,
};
pub use lease::{
    LeaseError, ManualAction, OutboundDecision, apply_manual_action, apply_outbound,
    evaluate_outbound, evaluate_state, record_inbound,
};
pub use message::{Message, MessageId, Provenance, ReplyIdentity, Route};
pub use quarantine::{
    DeleteReason, FaultInjector, FaultPoint, LEASE_QUARANTINE_RETENTION, METADATA_PURGE_GRACE,
    NoFaults, QuarantineError, QuarantineKind, QuarantineManager, QuarantineMetadata,
    QuarantineStatus, ReconciliationReport, RetentionLimits, RetentionPolicy, RetentionReport,
    SPAM_RETENTION,
};
pub use reply::{
    DkimSigner, FileOutboundQueue, OutboundMessage, OutboundMeta, OutboundQueue, ReplyClient,
    ReplyError, compose_reply, fetch_reply_context, select_reply_identity, submit_outbound,
};
pub use service::{AliasService, CreateAlias, ExpiryChoice, OutboundOutcome, ServiceError};
pub use timestamp::Timestamp;
pub use token::{ApiToken, IssuedToken, Scope, ScopeSet, TokenError, TokenId};

/// Product name reported by the server and used in diagnostics.
pub const PRODUCT_NAME: &str = "wickmail-server";

/// Version of the running server, taken from the crate metadata.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::{PRODUCT_NAME, version};

    #[test]
    fn product_name_is_stable() {
        assert_eq!(PRODUCT_NAME, "wickmail-server");
    }

    #[test]
    fn version_is_not_empty() {
        assert!(!version().is_empty());
    }
}
