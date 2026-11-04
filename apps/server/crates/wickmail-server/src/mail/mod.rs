//! Inbound mail path.
//!
//! This module implements the two enforcement points from ADR 0006: the RCPT
//! policy lookup Postfix calls over a socketmap, and the LMTP proxy that
//! applies delivery-time policy, strips client headers, adds trusted headers,
//! and spools durably before acknowledging. It also provides the internal
//! mail-store adapter used to read delivered and quarantined messages.

pub mod delivery;
pub mod headers;
pub mod lmtp;
pub mod policy;
pub mod runtime;
pub mod socketmap;
pub mod spool;
pub mod store;

pub use delivery::{PlannedDelivery, plan};
pub use headers::{MessageParts, WICKMAIL_HEADER_PREFIX};
pub use lmtp::{Envelope, LmtpClient, LmtpError, LmtpTarget, MessageHandler, RecipientReply};
pub use policy::{PolicyDecision, PolicyError, RecipientKind, RecipientPolicy};
pub use runtime::{MailPath, RuntimeError, ServerConfig, route_header_value, serve};
pub use socketmap::DEFAULT_SOCKETMAP_NAME;
pub use spool::{Spool, SpoolEntry, SpoolError, SpoolMeta, SpoolStats};
pub use store::{
    AdapterError, INBOX_MAILBOX, MailStoreAdapter, MailboxLocator, MessageSummary,
    QUARANTINE_MAILBOX, SPAM_MAILBOX,
};
