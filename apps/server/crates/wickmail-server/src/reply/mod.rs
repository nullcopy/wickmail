//! Reply-as-alias outbound path.
//!
//! This module implements the controlled reply flow: a sanitized reply-context
//! fetch scoped to messages with trusted provenance, provenance-based identity
//! selection, outbound identity enforcement, DKIM signing with DMARC
//! alignment, authenticated submission with renewal after queue acceptance,
//! and a reply client and CLI used by the walking skeleton and integration
//! tests. See [ADR 0008](../../../docs/decisions/0008-alias-native-replies.md).

pub mod client;
pub mod context;
pub mod dkim;
pub mod identity;
pub mod outbound;
pub mod queue;
pub mod sanitize;
pub mod submission;

pub use client::ReplyClient;
pub use context::fetch_reply_context;
pub use dkim::{
    DkimError, DkimSigner, DkimVerification, dmarc_aligned, public_key_from_pem, verify_dkim,
};
pub use identity::select_reply_identity;
pub use outbound::{
    ComposeReply, EnforceOptions, EnforcedMessage, compose_reply, enforce_outbound_identity,
};
pub use queue::{
    FileOutboundQueue, MemoryOutboundQueue, OutboundMessage, OutboundMeta, OutboundQueue,
    QueueError,
};
pub use submission::{SubmitOutbound, submit_outbound};

use thiserror::Error;

use crate::alias::AliasId;
use crate::db::StoreError;
use crate::mail::store::AdapterError;
use crate::message::MessageId;
use crate::service::ServiceError;

/// Failures on the reply path.
#[derive(Debug, Error)]
pub enum ReplyError {
    /// The alias database could not be read.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// The alias service rejected the operation.
    #[error(transparent)]
    Service(#[from] ServiceError),
    /// The mail store could not be read.
    #[error(transparent)]
    Adapter(#[from] AdapterError),
    /// The message has no trusted provenance or body.
    #[error("message not found: {0}")]
    MessageNotFound(MessageId),
    /// The selected alias does not exist.
    #[error("alias not found: {0}")]
    AliasNotFound(AliasId),
    /// The original message has no sender to reply to.
    #[error("the message has no sender to reply to")]
    NoSender,
    /// Several aliases received the message; the client must choose one.
    #[error("multiple aliases received this message; select one")]
    IdentityRequired,
    /// The requested alias did not receive the message.
    #[error("selected alias did not receive this message")]
    IdentityNotAllowed,
    /// The message failed the outbound identity check.
    #[error("outbound identity rejected: {0}")]
    IdentityRejected(String),
    /// The submission was rejected before it was queued.
    #[error("outbound submission rejected: {0}")]
    Rejected(String),
    /// The outbound queue could not accept the message.
    #[error(transparent)]
    Queue(#[from] QueueError),
    /// DKIM signing failed.
    #[error(transparent)]
    Dkim(#[from] DkimError),
}
