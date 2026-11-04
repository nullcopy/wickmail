//! Outbound message composition and identity enforcement.
//!
//! The server, not the client, guarantees the alias identity. A composed reply
//! must have exactly one `From` mailbox equal to the selected identity; a
//! present `Sender` must equal it; `Reply-To` is omitted by default and may
//! only name the selected identity. Inbound-only headers, the `X-Wickmail-*`
//! namespace, and headers that reveal the primary address are stripped. A
//! message that fails these checks is rejected before it is queued.

use crate::address::CanonicalAddress;
use crate::api::ReplyIdentityOption;
use crate::mail::headers::{Header, MessageParts, WICKMAIL_HEADER_PREFIX, mailbox_addresses};
use crate::message::MessageId;
use crate::timestamp::Timestamp;

use super::ReplyError;

/// Headers that carry inbound routing or authentication state.
///
/// They are inbound-only and never forwarded on an outbound reply.
pub const INBOUND_ONLY_HEADERS: &[&str] = &[
    "delivered-to",
    "x-envelope-to",
    "x-original-to",
    "envelope-to",
    "x-forwarded-to",
    "apparently-to",
    "return-path",
    "received",
    "authentication-results",
    "arc-seal",
    "arc-message-signature",
    "arc-authentication-results",
    "dkim-signature",
    "bcc",
];

/// Functional headers whose values the server sets or that carry the reply
/// recipient. They are exempt from the primary-address scan so a primary reply
/// is not stripped of its own `From`, `To`, or `Cc`.
const IDENTITY_HEADERS: &[&str] = &[
    "from",
    "sender",
    "reply-to",
    "to",
    "cc",
    "subject",
    "date",
    "message-id",
    "in-reply-to",
    "references",
    "mime-version",
    "content-type",
    "content-transfer-encoding",
    "content-disposition",
];

/// Input for the outbound identity check.
pub struct EnforceOptions<'a> {
    /// The identity address the reply must be sent as.
    pub sender_address: &'a CanonicalAddress,
    /// The SMTP envelope sender, when known; it must equal `sender_address`.
    pub envelope_sender: Option<&'a str>,
    /// Primary addresses whose appearance in a header must be stripped.
    pub primary_addresses: &'a [CanonicalAddress],
}

/// A message that passed identity enforcement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnforcedMessage {
    /// The message with inbound-only and primary-revealing headers removed.
    pub raw: Vec<u8>,
    /// The names of the headers that were removed.
    pub removed: Vec<String>,
}

/// Enforces outbound identity on a composed message.
pub fn enforce_outbound_identity(
    raw: &[u8],
    options: &EnforceOptions<'_>,
) -> Result<EnforcedMessage, ReplyError> {
    let sender = options.sender_address;

    if let Some(envelope) = options.envelope_sender {
        let parsed = parse_envelope_path(envelope);
        let canonical = CanonicalAddress::parse(&parsed).map_err(|_| {
            ReplyError::IdentityRejected("envelope sender is not a valid address".into())
        })?;
        if &canonical != sender {
            return Err(ReplyError::IdentityRejected(
                "envelope sender does not match the selected identity".into(),
            ));
        }
    }

    let mut message = MessageParts::parse(raw);

    let from = collect_mailboxes(&message, "From");
    if from.len() != 1 {
        return Err(ReplyError::IdentityRejected(
            "From must contain exactly one mailbox".into(),
        ));
    }
    if &from[0] != sender {
        return Err(ReplyError::IdentityRejected(
            "From does not match the selected identity".into(),
        ));
    }

    let sender_header = collect_mailboxes(&message, "Sender");
    if !sender_header.is_empty() && (sender_header.len() != 1 || &sender_header[0] != sender) {
        return Err(ReplyError::IdentityRejected(
            "Sender must equal the selected identity".into(),
        ));
    }

    let reply_to = collect_mailboxes(&message, "Reply-To");
    if !reply_to.is_empty() && (reply_to.len() != 1 || &reply_to[0] != sender) {
        return Err(ReplyError::IdentityRejected(
            "Reply-To may only be the selected identity".into(),
        ));
    }

    let removed = message
        .headers
        .retain(|header| !should_strip(header, options.primary_addresses));
    let removed = removed.into_iter().map(|header| header.name).collect();

    Ok(EnforcedMessage {
        raw: message.to_bytes(),
        removed,
    })
}

/// Input for composing a reply.
pub struct ComposeReply {
    /// The selected sending identity.
    pub identity: ReplyIdentityOption,
    /// The reply recipient, the original sender.
    pub to: String,
    /// The original subject; a `Re:` prefix is added when absent.
    pub subject: Option<String>,
    /// The original RFC 5322 `Message-ID`, for threading.
    pub original_message_id: Option<String>,
    /// The reply body.
    pub body: String,
    /// Optional quoted history, prefixed per line.
    pub quoted_text: Option<String>,
    /// The message identity assigned to the reply.
    pub message_id: MessageId,
    /// The composition time.
    pub now: Timestamp,
}

/// Composes a plain-text reply as the selected identity.
///
/// `Reply-To` is omitted. The `From` header is the sole mailbox of the
/// identity, and the message is ready for identity enforcement and DKIM
/// signing. No inbound-only headers are added.
pub fn compose_reply(input: &ComposeReply) -> Vec<u8> {
    let address = input.identity.address();
    let domain = address.domain();
    let from = address.as_str();

    let mut headers: Vec<String> = vec![
        format!("From: {from}"),
        format!("To: {}", input.to),
        format!("Date: {}", format_rfc2822(input.now)),
        format!("Message-ID: <{}@{}>", input.message_id, domain),
    ];
    if let Some(subject) = &input.subject {
        headers.push(format!("Subject: {}", reply_subject(subject)));
    }
    if let Some(original) = &input.original_message_id {
        headers.push(format!("In-Reply-To: {original}"));
        headers.push(format!("References: {original}"));
    }
    headers.push("MIME-Version: 1.0".to_string());
    headers.push("Content-Type: text/plain; charset=utf-8".to_string());
    headers.push("Content-Transfer-Encoding: 8bit".to_string());

    let mut body = input.body.replace("\r\n", "\n").replace('\r', "\n");
    if let Some(quoted) = &input.quoted_text {
        if !quoted.is_empty() {
            body.push_str("\n\n");
            body.push_str(&quote(quoted));
        }
    }
    let body = body.replace('\n', "\r\n");

    format!("{}\r\n\r\n{}", headers.join("\r\n"), body).into_bytes()
}

fn reply_subject(subject: &str) -> String {
    if subject.trim_start().to_ascii_lowercase().starts_with("re:") {
        subject.to_string()
    } else {
        format!("Re: {subject}")
    }
}

fn quote(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(|line| format!("> {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_rfc2822(now: Timestamp) -> String {
    use time::format_description::well_known::Rfc2822;
    now.offset_datetime()
        .format(&Rfc2822)
        .unwrap_or_else(|_| now.to_string())
}

fn collect_mailboxes(message: &MessageParts, name: &str) -> Vec<CanonicalAddress> {
    message
        .headers
        .get_all(name)
        .flat_map(mailbox_addresses)
        .collect()
}

fn should_strip(header: &Header, primary_addresses: &[CanonicalAddress]) -> bool {
    let name = header.name.trim().to_ascii_lowercase();
    if name.starts_with(WICKMAIL_HEADER_PREFIX) || INBOUND_ONLY_HEADERS.contains(&name.as_str()) {
        return true;
    }
    if IDENTITY_HEADERS.contains(&name.as_str()) || primary_addresses.is_empty() {
        return false;
    }
    let value = header.value.to_ascii_lowercase();
    primary_addresses
        .iter()
        .any(|primary| value.contains(primary.as_str()))
}

fn parse_envelope_path(value: &str) -> String {
    let trimmed = value.trim();
    match (trimmed.find('<'), trimmed.rfind('>')) {
        (Some(start), Some(end)) if end > start => trimmed[start + 1..end].trim().to_string(),
        _ => trimmed.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{ComposeReply, EnforceOptions, compose_reply, enforce_outbound_identity};
    use crate::address::CanonicalAddress;
    use crate::api::ReplyIdentityOption;
    use crate::message::MessageId;
    use crate::timestamp::Timestamp;

    fn alias_option() -> ReplyIdentityOption {
        ReplyIdentityOption::Alias {
            alias_id: "018f9b60-0000-7000-8000-00000000000a".parse().unwrap(),
            address: CanonicalAddress::parse("green.farm@example.com").unwrap(),
        }
    }

    fn compose() -> Vec<u8> {
        compose_reply(&ComposeReply {
            identity: alias_option(),
            to: "sender@example.net".to_string(),
            subject: Some("Your order".to_string()),
            original_message_id: Some("<orig@example.net>".to_string()),
            body: "Thanks!".to_string(),
            quoted_text: None,
            message_id: MessageId::from_uuid(
                "018f9b60-0000-7000-8000-0000000000aa".parse().unwrap(),
            ),
            now: "2026-01-04T00:00:00Z".parse::<Timestamp>().unwrap(),
        })
    }

    fn header(raw: &[u8], name: &str) -> Option<String> {
        let message = crate::mail::headers::MessageParts::parse(raw);
        message.headers.get(name).map(|value| value.to_string())
    }

    #[test]
    fn compose_sets_the_sole_from_and_omits_reply_to() {
        let raw = compose();
        assert_eq!(
            header(&raw, "From").as_deref(),
            Some("green.farm@example.com")
        );
        assert_eq!(header(&raw, "Reply-To"), None);
        assert_eq!(header(&raw, "To").as_deref(), Some("sender@example.net"));
        assert_eq!(header(&raw, "Subject").as_deref(), Some("Re: Your order"));
        assert_eq!(
            header(&raw, "In-Reply-To").as_deref(),
            Some("<orig@example.net>")
        );
    }

    #[test]
    fn accepts_a_composed_reply_and_strips_inbound_headers() {
        let mut with_inbound =
            b"X-Wickmail-Message-ID: spoofed\r\nDelivered-To: me@example.com\r\nX-Envelope-To: me@example.com\r\nReceived: from somewhere by me@example.com\r\nX-Custom: me@example.com\r\n".to_vec();
        with_inbound.extend_from_slice(&compose());

        let primary = CanonicalAddress::parse("me@example.com").unwrap();
        let result = enforce_outbound_identity(
            &with_inbound,
            &EnforceOptions {
                sender_address: &CanonicalAddress::parse("green.farm@example.com").unwrap(),
                envelope_sender: Some("green.farm@example.com"),
                primary_addresses: std::slice::from_ref(&primary),
            },
        )
        .unwrap();

        let text = String::from_utf8_lossy(&result.raw);
        assert!(!text.contains("spoofed"));
        assert_eq!(header(&result.raw, "Delivered-To"), None);
        assert_eq!(header(&result.raw, "X-Envelope-To"), None);
        assert_eq!(header(&result.raw, "Received"), None);
        assert_eq!(header(&result.raw, "X-Custom"), None);
        assert_eq!(
            header(&result.raw, "From").as_deref(),
            Some("green.farm@example.com")
        );
        assert!(result.removed.contains(&"Delivered-To".to_string()));
    }

    #[test]
    fn rejects_a_from_that_is_not_the_alias() {
        let raw = b"From: other@example.net\r\nTo: sender@example.net\r\n\r\nbody";
        let result = enforce_outbound_identity(
            raw,
            &EnforceOptions {
                sender_address: &CanonicalAddress::parse("green.farm@example.com").unwrap(),
                envelope_sender: None,
                primary_addresses: &[],
            },
        );
        assert!(matches!(
            result,
            Err(super::ReplyError::IdentityRejected(_))
        ));
    }

    #[test]
    fn rejects_multiple_from_mailboxes() {
        let raw = b"From: green.farm@example.com, other@example.net\r\nTo: sender@example.net\r\n\r\nbody";
        let result = enforce_outbound_identity(
            raw,
            &EnforceOptions {
                sender_address: &CanonicalAddress::parse("green.farm@example.com").unwrap(),
                envelope_sender: None,
                primary_addresses: &[],
            },
        );
        assert!(result.is_err());
    }

    #[test]
    fn rejects_a_mismatched_envelope_sender() {
        let raw = b"From: green.farm@example.com\r\nTo: sender@example.net\r\n\r\nbody";
        let result = enforce_outbound_identity(
            raw,
            &EnforceOptions {
                sender_address: &CanonicalAddress::parse("green.farm@example.com").unwrap(),
                envelope_sender: Some("me@example.com"),
                primary_addresses: &[],
            },
        );
        assert!(result.is_err());
    }

    #[test]
    fn keeps_sender_and_reply_to_when_they_match() {
        let raw = b"From: green.farm@example.com\r\nSender: green.farm@example.com\r\nReply-To: green.farm@example.com\r\nTo: sender@example.net\r\n\r\nbody";
        let result = enforce_outbound_identity(
            raw,
            &EnforceOptions {
                sender_address: &CanonicalAddress::parse("green.farm@example.com").unwrap(),
                envelope_sender: None,
                primary_addresses: &[],
            },
        )
        .unwrap();
        assert_eq!(
            header(&result.raw, "Sender").as_deref(),
            Some("green.farm@example.com")
        );
        assert_eq!(
            header(&result.raw, "Reply-To").as_deref(),
            Some("green.farm@example.com")
        );
    }

    #[test]
    fn rejects_a_reply_to_that_is_the_primary() {
        let raw = b"From: green.farm@example.com\r\nReply-To: me@example.com\r\nTo: sender@example.net\r\n\r\nbody";
        let result = enforce_outbound_identity(
            raw,
            &EnforceOptions {
                sender_address: &CanonicalAddress::parse("green.farm@example.com").unwrap(),
                envelope_sender: None,
                primary_addresses: &[CanonicalAddress::parse("me@example.com").unwrap()],
            },
        );
        assert!(result.is_err());
    }
}
