//! The reply client.
//!
//! The client drives reply-context fetch and reply submission through the same
//! server functions the management API will call, so it enforces the same
//! identity, lease, and header rules as any other client. It is the backend of
//! the reply CLI and the entry point used by integration tests.

use std::sync::{Arc, Mutex};

use crate::address::CanonicalAddress;
use crate::alias::AliasId;
use crate::api::{
    ReplyContextResponse, ReplyIdentityDecision, ReplyIdentityOption, ReplyRequest, ReplyResponse,
};
use crate::clock::SharedClock;
use crate::mail::store::MailStoreAdapter;
use crate::message::MessageId;
use crate::service::AliasService;

use super::ReplyError;
use super::context::fetch_reply_context;
use super::dkim::DkimSigner;
use super::outbound::{ComposeReply, compose_reply};
use super::queue::OutboundQueue;
use super::submission::{SubmitOutbound, submit_outbound};

/// The reply test client and CLI backend.
pub struct ReplyClient {
    service: Arc<Mutex<AliasService>>,
    mail: MailStoreAdapter,
    queue: Arc<dyn OutboundQueue>,
    dkim: Option<DkimSigner>,
    primary: Option<CanonicalAddress>,
    clock: SharedClock,
}

impl ReplyClient {
    /// Creates a client over the alias service, mail store, and outbound queue.
    pub fn new(
        service: Arc<Mutex<AliasService>>,
        mail: MailStoreAdapter,
        queue: Arc<dyn OutboundQueue>,
        dkim: Option<DkimSigner>,
        primary: Option<CanonicalAddress>,
        clock: SharedClock,
    ) -> Self {
        Self {
            service,
            mail,
            queue,
            dkim,
            primary,
            clock,
        }
    }

    /// The primary address offered as an alternative reply identity.
    pub fn primary(&self) -> Option<&CanonicalAddress> {
        self.primary.as_ref()
    }

    /// Fetches the sanitized reply context for a message.
    pub fn fetch_reply_context(
        &self,
        message_id: MessageId,
    ) -> Result<Option<ReplyContextResponse>, ReplyError> {
        let service = self.service.lock().expect("alias service lock poisoned");
        fetch_reply_context(
            service.store(),
            &self.mail,
            message_id,
            self.primary.as_ref(),
        )
    }

    /// Fetches reply context and submits a reply as the selected identity.
    pub fn submit_reply(
        &self,
        message_id: MessageId,
        request: &ReplyRequest,
    ) -> Result<ReplyResponse, ReplyError> {
        let context = self
            .fetch_reply_context(message_id)?
            .ok_or(ReplyError::MessageNotFound(message_id))?;
        let identity = resolve_identity(&context.identity, request.alias_id)?;
        let to = context.from.clone().ok_or(ReplyError::NoSender)?;

        let now = self.clock.now();
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

        let service = self.service.lock().expect("alias service lock poisoned");
        submit_outbound(
            &service,
            self.queue.as_ref(),
            self.dkim.as_ref(),
            self.primary.as_slice(),
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

    /// Submits a pre-composed outbound message.
    pub fn submit_outbound(&self, input: SubmitOutbound) -> Result<ReplyResponse, ReplyError> {
        let now = self.clock.now();
        let service = self.service.lock().expect("alias service lock poisoned");
        submit_outbound(
            &service,
            self.queue.as_ref(),
            self.dkim.as_ref(),
            self.primary.as_slice(),
            input,
            now,
        )
    }
}

fn resolve_identity(
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

#[cfg(test)]
mod tests {
    use super::resolve_identity;
    use crate::address::CanonicalAddress;
    use crate::alias::AliasId;
    use crate::api::{ReplyIdentityDecision, ReplyIdentityOption, ReplyIdentitySelection};
    use crate::reply::ReplyError;

    const ID_A: &str = "018f9b60-0000-7000-8000-00000000000a";
    const ID_B: &str = "018f9b60-0000-7000-8000-00000000000b";

    fn option(id: &str) -> ReplyIdentityOption {
        ReplyIdentityOption::Alias {
            alias_id: AliasId::from_uuid(id.parse().unwrap()),
            address: CanonicalAddress::parse("green.farm@example.com").unwrap(),
        }
    }

    #[test]
    fn requested_alias_must_be_an_option() {
        let decision = ReplyIdentityDecision {
            selection: ReplyIdentitySelection::Default,
            selected: Some(option(ID_A)),
            options: vec![option(ID_A)],
        };
        let selected =
            resolve_identity(&decision, Some(AliasId::from_uuid(ID_A.parse().unwrap()))).unwrap();
        assert_eq!(
            selected.alias_id(),
            Some(AliasId::from_uuid(ID_A.parse().unwrap()))
        );

        let denied = resolve_identity(&decision, Some(AliasId::from_uuid(ID_B.parse().unwrap())));
        assert!(matches!(denied, Err(ReplyError::IdentityNotAllowed)));
    }

    #[test]
    fn ambiguous_selection_requires_an_explicit_alias() {
        let decision = ReplyIdentityDecision {
            selection: ReplyIdentitySelection::Prompt,
            selected: None,
            options: vec![option(ID_A), option(ID_B)],
        };
        assert!(matches!(
            resolve_identity(&decision, None),
            Err(ReplyError::IdentityRequired)
        ));
    }
}
