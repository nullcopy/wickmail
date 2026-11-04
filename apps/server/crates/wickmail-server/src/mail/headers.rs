//! Message header parsing, stripping, and trusted-header insertion.
//!
//! The LMTP proxy operates on the raw message bytes so the body is never
//! rewritten. Only the header block is parsed, and client-supplied
//! `X-Wickmail-*` headers are removed before trusted headers are added.

use crate::address::CanonicalAddress;

/// Prefix reserved for Wickmail's inbound-only trusted headers.
pub const WICKMAIL_HEADER_PREFIX: &str = "x-wickmail-";

/// One header field: a name and its unfolded value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Header {
    /// Field name as received.
    pub name: String,
    /// Field value with folded lines joined and leading whitespace removed.
    pub value: String,
}

/// An ordered set of header fields.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Headers {
    entries: Vec<Header>,
}

impl Headers {
    /// An empty header set.
    pub fn new() -> Self {
        Self::default()
    }

    /// All headers in order.
    pub fn entries(&self) -> &[Header] {
        &self.entries
    }

    /// Whether there are no headers.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The first value for a field, matched case-insensitively.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|header| header.name.eq_ignore_ascii_case(name))
            .map(|header| header.value.as_str())
    }

    /// Every value for a field, matched case-insensitively, in order.
    pub fn get_all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> {
        self.entries
            .iter()
            .filter(move |header| header.name.eq_ignore_ascii_case(name))
            .map(|header| header.value.as_str())
    }

    /// Appends a header field.
    pub fn push(&mut self, name: impl Into<String>, value: impl Into<String>) {
        self.entries.push(Header {
            name: name.into(),
            value: value.into(),
        });
    }

    /// Removes every field whose name starts with `prefix`, case-insensitively.
    ///
    /// Returns the removed fields so callers can observe what was stripped.
    pub fn strip_prefix(&mut self, prefix: &str) -> Vec<Header> {
        let prefix = prefix.to_ascii_lowercase();
        let mut removed = Vec::new();
        let mut kept = Vec::with_capacity(self.entries.len());
        for header in self.entries.drain(..) {
            if header.name.to_ascii_lowercase().starts_with(&prefix) {
                removed.push(header);
            } else {
                kept.push(header);
            }
        }
        self.entries = kept;
        removed
    }

    /// Whether the message is classified as spam by the scanner.
    ///
    /// Recognizes the headers Rspamd and compatible scanners add: `X-Spam`,
    /// `X-Spam-Flag`, and `X-Spam-Status`.
    pub fn is_spam(&self) -> bool {
        if self
            .get("X-Spam")
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("yes"))
        {
            return true;
        }
        if self
            .get("X-Spam-Flag")
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("yes"))
        {
            return true;
        }
        if self
            .get("X-Spam-Status")
            .is_some_and(|value| value.trim().to_ascii_lowercase().starts_with("yes"))
        {
            return true;
        }
        false
    }

    /// Addresses named in the visible `To` and `Cc` headers.
    ///
    /// Used only to cross-check the trusted envelope recipients for display;
    /// the envelope remains authoritative.
    pub fn visible_recipients(&self) -> Vec<CanonicalAddress> {
        let mut addresses = Vec::new();
        for name in ["To", "Cc"] {
            for value in self.get_all(name) {
                for address in extract_addresses(value) {
                    if !addresses.contains(&address) {
                        addresses.push(address);
                    }
                }
            }
        }
        addresses
    }
}

/// A message split into its header block and untouched body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageParts {
    /// Parsed headers.
    pub headers: Headers,
    /// Body bytes, exactly as received after the blank separator line.
    pub body: Vec<u8>,
}

impl MessageParts {
    /// Splits raw message bytes into headers and body.
    ///
    /// Accepts both CRLF and bare LF line endings. A message with no blank
    /// separator line is treated as headers only.
    pub fn parse(raw: &[u8]) -> Self {
        let (header_bytes, body) = split_at_blank_line(raw);
        Self {
            headers: parse_headers(header_bytes),
            body: body.to_vec(),
        }
    }

    /// Serializes the message with CRLF line endings and a blank separator.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for header in self.headers.entries() {
            out.extend_from_slice(header.name.as_bytes());
            out.extend_from_slice(b": ");
            out.extend_from_slice(header.value.as_bytes());
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(b"\r\n");
        out.extend_from_slice(&self.body);
        out
    }
}

fn split_at_blank_line(raw: &[u8]) -> (&[u8], &[u8]) {
    if let Some(index) = find(raw, b"\r\n\r\n") {
        return (&raw[..index], &raw[index + 4..]);
    }
    if let Some(index) = find(raw, b"\n\n") {
        return (&raw[..index], &raw[index + 2..]);
    }
    (raw, &[])
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn parse_headers(block: &[u8]) -> Headers {
    let text = String::from_utf8_lossy(block);
    let mut headers = Headers::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            // Folded continuation of the previous field.
            if let Some(last) = headers.entries.last_mut() {
                last.value.push(' ');
                last.value.push_str(line.trim());
            }
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        headers.push(name.trim().to_string(), value.trim_start().to_string());
    }
    headers
}

/// Extracts bare email addresses from a header value such as
/// `"Example Store" <orders@example.com>, second@example.com`.
fn extract_addresses(value: &str) -> Vec<CanonicalAddress> {
    let mut addresses = Vec::new();
    for token in value.split(',') {
        let candidate = token
            .rsplit_once('<')
            .map(|(_, rest)| rest)
            .map(|rest| rest.trim_end_matches('>'))
            .unwrap_or(token)
            .trim()
            .trim_matches('"');
        if candidate.is_empty() || !candidate.contains('@') {
            continue;
        }
        if let Ok(address) = CanonicalAddress::parse(candidate) {
            if !addresses.contains(&address) {
                addresses.push(address);
            }
        }
    }
    addresses
}

#[cfg(test)]
mod tests {
    use super::{Headers, MessageParts, WICKMAIL_HEADER_PREFIX};
    use crate::address::CanonicalAddress;

    #[test]
    fn strips_client_wickmail_headers_case_insensitively() {
        let raw = b"From: a@example.com\r\n\
X-Wickmail-Route: Quarantine\r\n\
x-wickmail-alias-id: 018f9b60-0000-7000-8000-000000000001\r\n\
Subject: hello\r\n\
\r\nbody\r\n";
        let mut message = MessageParts::parse(raw);
        let removed = message.headers.strip_prefix(WICKMAIL_HEADER_PREFIX);
        assert_eq!(removed.len(), 2);
        assert!(message.headers.get("X-Wickmail-Route").is_none());
        assert_eq!(message.headers.get("Subject"), Some("hello"));
        assert_eq!(message.body, b"body\r\n");
    }

    #[test]
    fn unfolds_continuation_lines() {
        let raw = b"Subject: one\r\n two\r\n\tthree\r\n\r\n";
        let message = MessageParts::parse(raw);
        assert_eq!(message.headers.get("Subject"), Some("one two three"));
    }

    #[test]
    fn detects_spam_headers() {
        let mut headers = Headers::new();
        assert!(!headers.is_spam());
        headers.push("X-Spam", "No");
        assert!(!headers.is_spam());
        headers.push("X-Spam-Flag", "YES");
        assert!(headers.is_spam());
    }

    #[test]
    fn extracts_visible_recipients() {
        let raw = b"To: \"Example Store\" <orders@example.com>\r\nCc: second@example.com, orders@example.com\r\n\r\n";
        let message = MessageParts::parse(raw);
        let visible = message.headers.visible_recipients();
        assert_eq!(
            visible,
            vec![
                CanonicalAddress::parse("orders@example.com").unwrap(),
                CanonicalAddress::parse("second@example.com").unwrap(),
            ]
        );
    }

    #[test]
    fn round_trips_through_serialization() {
        let raw = b"From: a@example.com\r\nSubject: hi\r\n\r\nhello\nworld\r\n";
        let message = MessageParts::parse(raw);
        let rendered = message.to_bytes();
        assert!(rendered.ends_with(b"\r\n\r\nhello\nworld\r\n"));
        assert!(rendered.starts_with(b"From: a@example.com\r\n"));
    }

    #[test]
    fn handles_message_without_body_separator() {
        let message = MessageParts::parse(b"Subject: only headers");
        assert_eq!(message.headers.get("Subject"), Some("only headers"));
        assert!(message.body.is_empty());
    }
}
