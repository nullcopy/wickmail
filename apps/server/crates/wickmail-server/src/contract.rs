//! JSON fixtures that pin the management API contract.
//!
//! The Rust server owns the contract. The `packages/core` TypeScript client
//! validates these fixtures with its own schemas, so a change to a Rust type
//! fails the Rust fixture test until the fixtures are regenerated, and then
//! fails the TypeScript test until the client is updated. Regenerate with:
//!
//! ```text
//! WICKMAIL_UPDATE_FIXTURES=1 cargo test -p wickmail-server fixtures_are_current
//! ```

use serde::Serialize;

use crate::address::CanonicalAddress;
use crate::alias::{AliasId, AliasState, DEFAULT_LEASE_SECONDS};
use crate::api::{
    API_CONTRACT_VERSION, AliasEventResponse, AliasListResponse, AliasResponse, CreateAliasRequest,
    DurationRequest, EnableRequest, ErrorResponse, ExpiryRequest, ProvenanceResponse,
    ReplyContextResponse, ReplyRequest, ReplyResponse, SetExpiryRequest, UpdateAliasRequest,
};
use crate::audit::{AuditDetail, AuditEvent, AuditEventId, AuditEventKind};
use crate::message::{MessageId, Provenance};
use crate::timestamp::Timestamp;

/// The directory, relative to the crate root, that holds the fixtures.
pub const FIXTURE_DIR: &str = "fixtures";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContractVersion {
    api_contract_version: &'static str,
}

fn at(value: &str) -> Timestamp {
    value.parse().expect("fixture timestamp")
}

fn alias_id() -> AliasId {
    AliasId::from_uuid("018f9b60-0000-7000-8000-000000000001".parse().unwrap())
}

fn message_id() -> MessageId {
    MessageId::from_uuid("018f9b60-0000-7000-8000-0000000000aa".parse().unwrap())
}

/// The complete set of contract fixtures.
pub fn fixtures() -> Vec<(&'static str, String)> {
    vec![
        (
            "contract.json",
            pretty(&ContractVersion {
                api_contract_version: API_CONTRACT_VERSION,
            }),
        ),
        (
            "create-alias-request.json",
            pretty(&CreateAliasRequest {
                label: Some("Example Store".to_string()),
                purpose: Some("order #1234".to_string()),
                expiry: Some(ExpiryRequest::Lease {
                    seconds: Some(DEFAULT_LEASE_SECONDS),
                }),
                renew_on_outbound: Some(true),
            }),
        ),
        (
            "create-alias-absolute-request.json",
            pretty(&CreateAliasRequest {
                label: None,
                purpose: None,
                expiry: Some(ExpiryRequest::Absolute {
                    expires_at: at("2026-02-01T00:00:00Z"),
                }),
                renew_on_outbound: None,
            }),
        ),
        (
            "create-alias-never-request.json",
            pretty(&CreateAliasRequest {
                label: None,
                purpose: None,
                expiry: Some(ExpiryRequest::Never),
                renew_on_outbound: Some(false),
            }),
        ),
        (
            "update-alias-request.json",
            pretty(&UpdateAliasRequest {
                label: Some("Renamed Store".to_string()),
                purpose: None,
                renew_on_outbound: Some(false),
            }),
        ),
        (
            "duration-request.json",
            pretty(&DurationRequest {
                seconds: Some(86_400),
            }),
        ),
        (
            "set-expiry-request.json",
            pretty(&SetExpiryRequest {
                expires_at: at("2026-02-01T00:00:00Z"),
            }),
        ),
        (
            "enable-request.json",
            pretty(&EnableRequest {
                expires_at: Some(at("2026-02-01T00:00:00Z")),
            }),
        ),
        ("alias-response.json", pretty(&alias_response())),
        ("alias-list-response.json", pretty(&alias_list())),
        ("alias-event.json", pretty(&alias_event())),
        (
            "error-response.json",
            pretty(&ErrorResponse {
                code: "alias_not_found".to_string(),
                message: "alias not found".to_string(),
            }),
        ),
        ("reply-context.json", pretty(&reply_context())),
        (
            "reply-request.json",
            pretty(&ReplyRequest {
                alias_id: alias_id(),
                body: "Thanks, that works.".to_string(),
                quoted_text: Some("> Original message".to_string()),
            }),
        ),
        (
            "reply-response.json",
            pretty(&ReplyResponse {
                queued: true,
                message_id: message_id(),
            }),
        ),
    ]
}

fn alias_response() -> AliasResponse {
    AliasResponse {
        id: alias_id(),
        address: CanonicalAddress::parse("green.farm@example.com").unwrap(),
        label: Some("Example Store".to_string()),
        purpose: Some("order #1234".to_string()),
        state: AliasState::Active,
        created_at: at("2026-01-01T00:00:00Z"),
        expires_at: Some(at("2026-01-08T00:00:00Z")),
        disabled_at: None,
        lease_seconds: DEFAULT_LEASE_SECONDS,
        renew_on_outbound: true,
        last_inbound_at: Some(at("2026-01-03T12:00:00Z")),
        last_user_activity_at: Some(at("2026-01-04T00:00:00Z")),
        last_used_at: at("2026-01-04T00:00:00Z"),
        policy_version: 2,
    }
}

fn alias_list() -> AliasListResponse {
    AliasListResponse {
        items: vec![alias_response()],
        next_cursor: None,
    }
}

fn alias_event() -> AliasEventResponse {
    AliasEventResponse::from(AuditEvent {
        id: AuditEventId::from_uuid("018f9b60-0000-7000-8000-0000000000bb".parse().unwrap()),
        alias_id: alias_id(),
        kind: AuditEventKind::RenewedByOutbound,
        created_at: at("2026-01-04T00:00:00Z"),
        detail: Some(AuditDetail {
            previous_expires_at: Some(at("2026-01-08T00:00:00Z")),
            expires_at: Some(at("2026-01-11T00:00:00Z")),
            lease_seconds: Some(DEFAULT_LEASE_SECONDS),
            message_id: None,
        }),
    })
}

fn reply_context() -> ReplyContextResponse {
    ReplyContextResponse {
        message_id: message_id(),
        from: "store@example.com".to_string(),
        subject: "Your order".to_string(),
        text: "Your order shipped.".to_string(),
        provenance: ProvenanceResponse::from(Provenance {
            alias_ids: vec![alias_id()],
            primary_received: true,
        }),
    }
}

fn pretty<T: Serialize>(value: &T) -> String {
    let mut json = serde_json::to_string_pretty(value).expect("serialize fixture");
    json.push('\n');
    json
}

#[cfg(test)]
mod tests {
    use super::{FIXTURE_DIR, fixtures};
    use std::path::PathBuf;

    fn fixture_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(FIXTURE_DIR)
    }

    #[test]
    fn fixtures_are_current() {
        let directory = fixture_dir();
        if std::env::var_os("WICKMAIL_UPDATE_FIXTURES").is_some() {
            std::fs::create_dir_all(&directory).unwrap();
            for (name, json) in fixtures() {
                std::fs::write(directory.join(name), json).unwrap();
            }
            return;
        }
        for (name, json) in fixtures() {
            let path = directory.join(name);
            let committed = std::fs::read_to_string(&path).unwrap_or_else(|_| {
                panic!("missing fixture {name}; run WICKMAIL_UPDATE_FIXTURES=1 cargo test -p wickmail-server")
            });
            assert_eq!(
                committed, json,
                "fixture {name} is stale; regenerate with WICKMAIL_UPDATE_FIXTURES=1"
            );
        }
    }
}
