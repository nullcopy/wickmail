//! Authenticated outbound submission.
//!
//! The message is checked before it is queued: the identity must be an owned
//! alias, the lease must permit outbound mail, and the message must pass
//! outbound identity enforcement. Only after the message is accepted and
//! queued does an alias renew, so pre-queue checks never extend a lease and a
//! later bounce cannot revert the renewal. A disabled alias is always
//! rejected, and an expired alias is rejected unless `renew_on_outbound` is
//! set.

use crate::address::CanonicalAddress;
use crate::alias::AliasId;
use crate::api::{ReplyIdentityDecision, ReplyIdentityOption, ReplyRequest, ReplyResponse};
use crate::lease::{OutboundDecision, evaluate_outbound};
use crate::mail::store::MailStoreAdapter;
use crate::message::MessageId;
use crate::service::AliasService;
use crate::timestamp::Timestamp;

use super::ReplyError;
use super::context::fetch_reply_context;
use super::dkim::DkimSigner;
use super::outbound::{ComposeReply, EnforceOptions, compose_reply, enforce_outbound_identity};
use super::queue::{OutboundMessage, OutboundMeta, OutboundQueue};

/// Input for an authenticated outbound submission.
pub struct SubmitOutbound {
    /// The selected sending identity.
    pub identity: ReplyIdentityOption,
    /// The composed message, before signing.
    pub raw: Vec<u8>,
    /// The SMTP envelope recipients.
    pub recipients: Vec<String>,
    /// The SMTP envelope sender; defaults to the identity address.
    pub envelope_sender: Option<String>,
    /// Overrides the generated message identity, for deterministic tests.
    pub message_id: Option<MessageId>,
}

/// Fetches reply context and submits a reply as the selected identity.
///
/// This is the single implementation shared by the reply client and the
/// management API, so both enforce the same provenance, identity, and lease
/// rules.
#[allow(clippy::too_many_arguments)]
pub fn submit_reply(
    service: &AliasService,
    mail: &MailStoreAdapter,
    queue: &dyn OutboundQueue,
    dkim: Option<&DkimSigner>,
    primary: Option<&CanonicalAddress>,
    message_id: MessageId,
    request: &ReplyRequest,
    now: Timestamp,
) -> Result<ReplyResponse, ReplyError> {
    let context = fetch_reply_context(service.store(), mail, message_id, primary)?
        .ok_or(ReplyError::MessageNotFound(message_id))?;
    let identity = if request.primary.unwrap_or(false) {
        select_primary(&context.identity)?
    } else {
        resolve_reply_identity(&context.identity, request.alias_id)?
    };
    let to = context.from.clone().ok_or(ReplyError::NoSender)?;
    let outbound_id = MessageId::new();
    let raw = compose_reply(&ComposeReply {
        identity: identity.clone(),
        to: to.clone(),
        subject: context.subject.clone(),
        original_message_id: context.original_message_id.clone(),
        body: request.body.clone(),
        quoted_text: request.quoted_text.clone(),
        message_id: outbound_id,
        now,
    });

    submit_outbound(
        service,
        queue,
        dkim,
        primary.map(std::slice::from_ref).unwrap_or(&[]),
        SubmitOutbound {
            identity,
            raw,
            recipients: vec![to],
            envelope_sender: None,
            message_id: Some(outbound_id),
        },
        now,
    )
}

/// Resolves a requested alias against the identities provenance allows.
///
/// A requested alias must be one of the offered options; omitting it uses the
/// server-selected default and fails when the client must prompt.
pub fn resolve_reply_identity(
    decision: &ReplyIdentityDecision,
    requested: Option<AliasId>,
) -> Result<ReplyIdentityOption, ReplyError> {
    match requested {
        Some(alias_id) => decision
            .options
            .iter()
            .find(|option| option.alias_id() == Some(alias_id))
            .cloned()
            .ok_or(ReplyError::IdentityNotAllowed),
        None => decision
            .selected
            .clone()
            .ok_or(ReplyError::IdentityRequired),
    }
}

/// Selects the account's primary identity from the offered options.
fn select_primary(decision: &ReplyIdentityDecision) -> Result<ReplyIdentityOption, ReplyError> {
    decision
        .options
        .iter()
        .find(|option| matches!(option, ReplyIdentityOption::Primary { .. }))
        .cloned()
        .ok_or(ReplyError::IdentityNotAllowed)
}

/// Submits an authenticated outbound message and renews its alias.
///
/// `primary_addresses` are stripped from outbound headers so the primary
/// address cannot leak. `dkim` signs the message when configured.
pub fn submit_outbound(
    service: &AliasService,
    queue: &dyn OutboundQueue,
    dkim: Option<&DkimSigner>,
    primary_addresses: &[CanonicalAddress],
    input: SubmitOutbound,
    now: Timestamp,
) -> Result<ReplyResponse, ReplyError> {
    let (sender, alias_id) = resolve_sender(service, &input.identity, now)?;

    let envelope_sender = input
        .envelope_sender
        .clone()
        .unwrap_or_else(|| sender.to_string());
    let enforced = enforce_outbound_identity(
        &input.raw,
        &EnforceOptions {
            sender_address: &sender,
            envelope_sender: Some(&envelope_sender),
            primary_addresses,
        },
    )?;

    let raw = match dkim {
        Some(signer) => signer.sign(&enforced.raw, now)?,
        None => enforced.raw,
    };

    let message_id = input.message_id.unwrap_or_default();
    let message = OutboundMessage {
        meta: OutboundMeta {
            id: message_id,
            alias_id,
            envelope_sender: canonicalize_safely(&envelope_sender),
            envelope_recipients: input
                .recipients
                .iter()
                .map(|value| canonicalize_safely(value))
                .collect(),
            queued_at: now,
            attempts: 0,
        },
        raw,
    };
    queue.enqueue(&message)?;

    // The alias renews only after the message is accepted and queued.
    let (renewed, expires_at) = match alias_id {
        Some(alias_id) => {
            let outcome = service.record_outbound(alias_id, Some(message_id))?;
            (
                outcome.decision == OutboundDecision::AcceptRenew,
                outcome.alias.expires_at,
            )
        }
        None => (false, None),
    };

    Ok(ReplyResponse {
        queued: true,
        message_id,
        identity: input.identity,
        renewed,
        expires_at,
    })
}

/// Resolves the sending address and optional alias, enforcing lease policy.
fn resolve_sender(
    service: &AliasService,
    identity: &ReplyIdentityOption,
    now: Timestamp,
) -> Result<(CanonicalAddress, Option<AliasId>), ReplyError> {
    let (alias_id, address) = match identity {
        ReplyIdentityOption::Alias { alias_id, address } => (Some(*alias_id), address),
        ReplyIdentityOption::Primary { address } => (None, address),
    };
    let Some(alias_id) = alias_id else {
        return Ok((address.clone(), None));
    };

    let alias = service
        .get(alias_id)?
        .ok_or(ReplyError::AliasNotFound(alias_id))?;
    if &alias.address != address {
        return Err(ReplyError::Rejected(
            "selected alias does not match the owned alias".to_string(),
        ));
    }
    match evaluate_outbound(&alias, now) {
        OutboundDecision::RejectDisabled => {
            return Err(ReplyError::Rejected("alias is disabled".to_string()));
        }
        OutboundDecision::RejectExpired => {
            return Err(ReplyError::Rejected(
                "alias is expired and does not renew on outbound".to_string(),
            ));
        }
        OutboundDecision::AcceptRenew | OutboundDecision::AcceptUnchanged => {}
    }
    Ok((alias.address, Some(alias_id)))
}

fn canonicalize_safely(value: &str) -> String {
    CanonicalAddress::parse(value)
        .map(|address| address.as_str().to_string())
        .unwrap_or_else(|_| value.trim().to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::SubmitOutbound;
    use crate::address::{CanonicalAddress, Domain};
    use crate::alias::{Alias, AliasId};
    use crate::api::ReplyIdentityOption;
    use crate::clock::FixedClock;
    use crate::db::Store;
    use crate::generator::AliasGenerator;
    use crate::message::MessageId;
    use crate::reply::ReplyError;
    use crate::reply::outbound::ComposeReply;
    use crate::reply::queue::{
        MemoryOutboundQueue, OutboundMessage, OutboundMeta, OutboundQueue, QueueError,
    };
    use crate::reply::{compose_reply, submit_outbound as submit};
    use crate::service::AliasService;
    use crate::timestamp::Timestamp;
    use std::sync::Arc;

    fn at(value: &str) -> Timestamp {
        value.parse().unwrap()
    }

    const LEASE_SECONDS: i64 = 3600;

    fn service() -> AliasService {
        let mut store = Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        AliasService::new(
            store,
            AliasGenerator::new(),
            Domain::parse("example.com").unwrap(),
            Arc::new(FixedClock::new(at("2026-01-04T00:00:00Z"))),
        )
    }

    fn insert(service: &AliasService, expires_at: Timestamp, renew: bool) -> Alias {
        let alias = Alias {
            id: AliasId::new(),
            address: CanonicalAddress::parse("green.farm@example.com").unwrap(),
            label: None,
            purpose: None,
            created_at: at("2026-01-01T00:00:00Z"),
            expires_at: Some(expires_at),
            disabled_at: None,
            lease_duration_seconds: LEASE_SECONDS,
            renew_on_outbound: renew,
            last_inbound_at: None,
            last_user_activity_at: None,
            policy_version: 0,
        };
        service.store().insert_alias(&alias).unwrap();
        alias
    }

    fn reply(alias: &Alias) -> Vec<u8> {
        compose_reply(&ComposeReply {
            identity: ReplyIdentityOption::Alias {
                alias_id: alias.id,
                address: alias.address.clone(),
            },
            to: "sender@example.net".to_string(),
            subject: Some("Hi".to_string()),
            original_message_id: None,
            body: "body".to_string(),
            quoted_text: None,
            message_id: MessageId::new(),
            now: at("2026-01-04T00:00:00Z"),
        })
    }

    fn alias_identity(alias: &Alias) -> ReplyIdentityOption {
        ReplyIdentityOption::Alias {
            alias_id: alias.id,
            address: alias.address.clone(),
        }
    }

    #[test]
    fn active_alias_renews_when_policy_allows() {
        let service = service();
        let alias = insert(&service, at("2026-01-05T00:00:00Z"), true);
        let queue = MemoryOutboundQueue::new();
        let result = submit(
            &service,
            &queue,
            None,
            &[],
            SubmitOutbound {
                identity: alias_identity(&alias),
                raw: reply(&alias),
                recipients: vec!["sender@example.net".to_string()],
                envelope_sender: None,
                message_id: None,
            },
            at("2026-01-04T00:00:00Z"),
        )
        .unwrap();
        assert!(result.renewed);
        assert_eq!(result.expires_at, Some(at("2026-01-04T01:00:00Z")));
        assert_eq!(queue.list().unwrap().len(), 1);
        assert_eq!(
            service.get(alias.id).unwrap().unwrap().expires_at,
            Some(at("2026-01-04T01:00:00Z"))
        );
    }

    #[test]
    fn active_alias_accepts_without_renewing_when_policy_disallows() {
        let service = service();
        let alias = insert(&service, at("2026-01-05T00:00:00Z"), false);
        let queue = MemoryOutboundQueue::new();
        let result = submit(
            &service,
            &queue,
            None,
            &[],
            SubmitOutbound {
                identity: alias_identity(&alias),
                raw: reply(&alias),
                recipients: vec!["sender@example.net".to_string()],
                envelope_sender: None,
                message_id: None,
            },
            at("2026-01-04T00:00:00Z"),
        )
        .unwrap();
        assert!(!result.renewed);
        assert_eq!(result.expires_at, Some(at("2026-01-05T00:00:00Z")));
        let stored = service.get(alias.id).unwrap().unwrap();
        assert_eq!(stored.expires_at, Some(at("2026-01-05T00:00:00Z")));
        assert_eq!(
            stored.last_user_activity_at,
            Some(at("2026-01-04T00:00:00Z"))
        );
    }

    #[test]
    fn expired_alias_reactivates_when_policy_allows() {
        let service = service();
        let alias = insert(&service, at("2026-01-03T00:00:00Z"), true);
        let queue = MemoryOutboundQueue::new();
        let result = submit(
            &service,
            &queue,
            None,
            &[],
            SubmitOutbound {
                identity: alias_identity(&alias),
                raw: reply(&alias),
                recipients: vec!["sender@example.net".to_string()],
                envelope_sender: None,
                message_id: None,
            },
            at("2026-01-04T00:00:00Z"),
        )
        .unwrap();
        assert!(result.renewed);
        assert_eq!(result.expires_at, Some(at("2026-01-04T01:00:00Z")));
    }

    #[test]
    fn expired_alias_is_rejected_when_policy_disallows() {
        let service = service();
        let alias = insert(&service, at("2026-01-03T00:00:00Z"), false);
        let queue = MemoryOutboundQueue::new();
        let result = submit(
            &service,
            &queue,
            None,
            &[],
            SubmitOutbound {
                identity: alias_identity(&alias),
                raw: reply(&alias),
                recipients: vec!["sender@example.net".to_string()],
                envelope_sender: None,
                message_id: None,
            },
            at("2026-01-04T00:00:00Z"),
        );
        assert!(matches!(result, Err(ReplyError::Rejected(_))));
        assert!(queue.list().unwrap().is_empty());
        assert_eq!(
            service.get(alias.id).unwrap().unwrap().expires_at,
            Some(at("2026-01-03T00:00:00Z"))
        );
    }

    #[test]
    fn disabled_alias_is_rejected() {
        let service = service();
        let alias = insert(&service, at("2026-01-05T00:00:00Z"), true);
        service.disable(alias.id).unwrap();
        let queue = MemoryOutboundQueue::new();
        let result = submit(
            &service,
            &queue,
            None,
            &[],
            SubmitOutbound {
                identity: alias_identity(&alias),
                raw: reply(&alias),
                recipients: vec!["sender@example.net".to_string()],
                envelope_sender: None,
                message_id: None,
            },
            at("2026-01-04T00:00:00Z"),
        );
        assert!(matches!(result, Err(ReplyError::Rejected(_))));
        assert!(queue.list().unwrap().is_empty());
    }

    struct FailingQueue;

    impl OutboundQueue for FailingQueue {
        fn enqueue(&self, _message: &OutboundMessage) -> Result<(), QueueError> {
            Err(QueueError::Io(std::io::Error::other("queue down")))
        }
        fn list(&self) -> Result<Vec<OutboundMeta>, QueueError> {
            Ok(Vec::new())
        }
        fn get(&self, _id: MessageId) -> Result<Option<OutboundMessage>, QueueError> {
            Ok(None)
        }
        fn remove(&self, _id: MessageId) -> Result<(), QueueError> {
            Ok(())
        }
    }

    #[test]
    fn a_queue_failure_does_not_renew_the_alias() {
        let service = service();
        let alias = insert(&service, at("2026-01-03T00:00:00Z"), true);
        let result = submit(
            &service,
            &FailingQueue,
            None,
            &[],
            SubmitOutbound {
                identity: alias_identity(&alias),
                raw: reply(&alias),
                recipients: vec!["sender@example.net".to_string()],
                envelope_sender: None,
                message_id: None,
            },
            at("2026-01-04T00:00:00Z"),
        );
        assert!(matches!(result, Err(ReplyError::Queue(_))));
        assert_eq!(
            service.get(alias.id).unwrap().unwrap().expires_at,
            Some(at("2026-01-03T00:00:00Z"))
        );
    }

    #[test]
    fn a_later_bounce_does_not_revert_the_renewal() {
        let service = service();
        let alias = insert(&service, at("2026-01-03T00:00:00Z"), true);
        let queue = MemoryOutboundQueue::new();
        let result = submit(
            &service,
            &queue,
            None,
            &[],
            SubmitOutbound {
                identity: alias_identity(&alias),
                raw: reply(&alias),
                recipients: vec!["sender@example.net".to_string()],
                envelope_sender: None,
                message_id: None,
            },
            at("2026-01-04T00:00:00Z"),
        )
        .unwrap();
        assert!(result.renewed);

        // The message bounces and leaves the queue; the lease stays renewed.
        queue.remove(result.message_id).unwrap();
        assert_eq!(
            service.get(alias.id).unwrap().unwrap().expires_at,
            Some(at("2026-01-04T01:00:00Z"))
        );
    }

    #[test]
    fn a_failing_identity_check_is_rejected_before_queueing() {
        let service = service();
        let alias = insert(&service, at("2026-01-05T00:00:00Z"), true);
        let queue = MemoryOutboundQueue::new();
        let raw = b"From: other@example.net\r\nTo: sender@example.net\r\n\r\nbody".to_vec();
        let result = submit(
            &service,
            &queue,
            None,
            &[],
            SubmitOutbound {
                identity: alias_identity(&alias),
                raw,
                recipients: vec!["sender@example.net".to_string()],
                envelope_sender: None,
                message_id: None,
            },
            at("2026-01-04T00:00:00Z"),
        );
        assert!(matches!(result, Err(ReplyError::IdentityRejected(_))));
        assert!(queue.list().unwrap().is_empty());
    }

    #[test]
    fn primary_identity_queues_without_renewing() {
        let service = service();
        let queue = MemoryOutboundQueue::new();
        let primary = CanonicalAddress::parse("me@example.com").unwrap();
        let raw = compose_reply(&ComposeReply {
            identity: ReplyIdentityOption::Primary {
                address: primary.clone(),
            },
            to: "sender@example.net".to_string(),
            subject: Some("Hi".to_string()),
            original_message_id: None,
            body: "body".to_string(),
            quoted_text: None,
            message_id: MessageId::new(),
            now: at("2026-01-04T00:00:00Z"),
        });
        let result = submit(
            &service,
            &queue,
            None,
            std::slice::from_ref(&primary),
            SubmitOutbound {
                identity: ReplyIdentityOption::Primary {
                    address: primary.clone(),
                },
                raw,
                recipients: vec!["sender@example.net".to_string()],
                envelope_sender: None,
                message_id: None,
            },
            at("2026-01-04T00:00:00Z"),
        )
        .unwrap();
        assert!(!result.renewed);
        assert!(result.expires_at.is_none());
        let queued = queue.list().unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].alias_id, None);
        assert_eq!(queued[0].envelope_sender, "me@example.com");
    }

    #[test]
    fn missing_alias_is_rejected() {
        let service = service();
        let queue = MemoryOutboundQueue::new();
        let result = submit(
            &service,
            &queue,
            None,
            &[],
            SubmitOutbound {
                identity: ReplyIdentityOption::Alias {
                    alias_id: AliasId::new(),
                    address: CanonicalAddress::parse("missing@example.com").unwrap(),
                },
                raw: b"From: missing@example.com\r\nTo: sender@example.net\r\n\r\nbody".to_vec(),
                recipients: vec!["sender@example.net".to_string()],
                envelope_sender: None,
                message_id: None,
            },
            at("2026-01-04T00:00:00Z"),
        );
        assert!(matches!(result, Err(ReplyError::AliasNotFound(_))));
    }
}
