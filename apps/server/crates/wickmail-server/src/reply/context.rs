//! Sanitized reply-context fetch.
//!
//! The fetch is scoped to messages the server accepted: a message without
//! trusted provenance resolves to `None`, and the mail store is read only by
//! the stable message ID. It returns the original sender, subject, sanitized
//! plain-text body, threading message ID, trusted provenance, and the identity
//! decision. It does not expose folders, search, or arbitrary headers, and it
//! never logs a message body.

use crate::address::CanonicalAddress;
use crate::alias::Alias;
use crate::api::ReplyContextResponse;
use crate::db::Store;
use crate::mail::headers::MessageParts;
use crate::mail::store::MailStoreAdapter;
use crate::message::MessageId;

use super::ReplyError;
use super::identity::select_reply_identity;
use super::sanitize::{
    MAX_HEADER_VALUE_LENGTH, extract_text_body, sanitize_header_value, sanitize_sender,
    sanitize_subject,
};

/// Mailboxes searched for a delivered message, in preference order.
const REPLY_MAILBOXES: &[&str] = &["Inbox", "Spam"];

/// Fetches the sanitized reply context for one message.
///
/// Returns `None` when the message has no trusted provenance or its bytes are
/// not in the mail store.
pub fn fetch_reply_context(
    store: &Store,
    mail: &MailStoreAdapter,
    message_id: MessageId,
    primary: Option<&CanonicalAddress>,
) -> Result<Option<ReplyContextResponse>, ReplyError> {
    let Some(message) = store.get_message(message_id)? else {
        return Ok(None);
    };

    let Some(raw) = read_delivered(mail, message_id)? else {
        return Ok(None);
    };

    let parts = MessageParts::parse(&raw);
    let original_message_id = parts
        .headers
        .get("Message-ID")
        .map(|value| sanitize_header_value(value, MAX_HEADER_VALUE_LENGTH))
        .filter(|value| !value.is_empty());

    let mut aliases: Vec<Alias> = Vec::new();
    for alias_id in &message.alias_ids {
        if let Some(alias) = store.get_alias(*alias_id)? {
            aliases.push(alias);
        }
    }

    let provenance = crate::message::Provenance {
        alias_ids: message.alias_ids.clone(),
        primary_received: message.primary_received,
    };
    let identity = select_reply_identity(&provenance, &aliases, primary);

    Ok(Some(ReplyContextResponse {
        message_id,
        from: sanitize_sender(&parts),
        subject: sanitize_subject(&parts),
        text: extract_text_body(&parts),
        original_message_id,
        provenance: provenance.into(),
        identity,
    }))
}

fn read_delivered(
    mail: &MailStoreAdapter,
    message_id: MessageId,
) -> Result<Option<Vec<u8>>, ReplyError> {
    for mailbox in REPLY_MAILBOXES {
        if let Some(bytes) = mail.read(mailbox, message_id)? {
            return Ok(Some(bytes));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::fetch_reply_context;
    use crate::address::CanonicalAddress;
    use crate::alias::{Alias, AliasId, DEFAULT_LEASE_SECONDS};
    use crate::api::{ReplyIdentityOption, ReplyIdentitySelection};
    use crate::db::Store;
    use crate::mail::store::MailStoreAdapter;
    use crate::message::{Message, MessageId, Route};
    use crate::timestamp::Timestamp;
    use std::fs;
    use std::path::Path;

    fn at(value: &str) -> Timestamp {
        value.parse().unwrap()
    }

    fn store_with_alias(id: &str, address: &str) -> (Store, Alias) {
        let mut store = Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        let alias = Alias {
            id: AliasId::from_uuid(id.parse().unwrap()),
            address: CanonicalAddress::parse(address).unwrap(),
            label: None,
            purpose: None,
            created_at: at("2026-01-01T00:00:00Z"),
            expires_at: None,
            disabled_at: None,
            lease_duration_seconds: DEFAULT_LEASE_SECONDS,
            renew_on_outbound: true,
            last_inbound_at: None,
            last_user_activity_at: None,
            policy_version: 0,
        };
        store.insert_alias(&alias).unwrap();
        (store, alias)
    }

    fn record(store: &Store, id: MessageId, alias: &Alias, primary: bool, sender: &str) {
        store
            .record_inbound_delivery(&Message {
                id,
                alias_ids: vec![alias.id],
                primary_received: primary,
                sender: sender.to_string(),
                subject: "Your order".to_string(),
                received_at: at("2026-01-04T00:00:00Z"),
                route: Route::Inbox,
            })
            .unwrap();
    }

    fn write_message(dir: &Path, sub: &str, name: &str, message_id: MessageId, raw: &str) {
        let folder = dir.join(sub);
        fs::create_dir_all(&folder).unwrap();
        let contents = format!("X-Wickmail-Message-ID: {message_id}\r\n{raw}");
        fs::write(folder.join(name), contents).unwrap();
    }

    const ID_A: &str = "018f9b60-0000-7000-8000-00000000000a";

    #[test]
    fn returns_sender_subject_text_and_provenance() {
        let (store, alias) = store_with_alias(ID_A, "green.farm@example.com");
        let id = MessageId::new();
        record(&store, id, &alias, true, "sender@example.net");

        let dir = tempfile::tempdir().unwrap();
        let adapter = MailStoreAdapter::open(dir.path());
        write_message(
            dir.path(),
            "cur",
            "1",
            id,
            "From: Sender Name <sender@example.net>\r\nSubject: Your order\r\nMessage-ID: <orig@example.net>\r\n\r\nThanks for your order.",
        );

        let primary = CanonicalAddress::parse("me@example.com").unwrap();
        let context = fetch_reply_context(&store, &adapter, id, Some(&primary))
            .unwrap()
            .expect("context");
        assert_eq!(context.from.as_deref(), Some("sender@example.net"));
        assert_eq!(context.subject.as_deref(), Some("Your order"));
        assert_eq!(context.text, "Thanks for your order.");
        assert_eq!(
            context.original_message_id.as_deref(),
            Some("<orig@example.net>")
        );
        assert_eq!(context.provenance.alias_ids, vec![alias.id]);
        assert_eq!(context.identity.selection, ReplyIdentitySelection::Default);
        assert_eq!(
            context.identity.selected,
            Some(ReplyIdentityOption::Alias {
                alias_id: alias.id,
                address: alias.address.clone(),
            })
        );
    }

    #[test]
    fn is_scoped_to_messages_with_provenance() {
        let (store, _alias) = store_with_alias(ID_A, "green.farm@example.com");
        let dir = tempfile::tempdir().unwrap();
        let adapter = MailStoreAdapter::open(dir.path());
        write_message(
            dir.path(),
            "cur",
            "1",
            MessageId::new(),
            "From: a@b.example\r\n\r\nbody",
        );

        let unknown = MessageId::new();
        assert!(
            fetch_reply_context(&store, &adapter, unknown, None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn returns_none_when_the_body_is_missing() {
        let (store, alias) = store_with_alias(ID_A, "green.farm@example.com");
        let id = MessageId::new();
        record(&store, id, &alias, false, "sender@example.net");

        let dir = tempfile::tempdir().unwrap();
        let adapter = MailStoreAdapter::open(dir.path());
        assert!(
            fetch_reply_context(&store, &adapter, id, None)
                .unwrap()
                .is_none()
        );
    }
}
