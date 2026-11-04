//! Reply-context sanitization.
//!
//! Reply context surfaces only the original sender, subject, and plain-text
//! body. Values are stripped of control characters and line breaks so they
//! cannot inject headers, and bodies are reduced to text with a length cap.
//! Message bodies are never logged.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;

use crate::address::CanonicalAddress;
use crate::mail::headers::{MessageParts, mailbox_addresses};

/// The maximum length of a sanitized header value.
pub const MAX_HEADER_VALUE_LENGTH: usize = 998;

/// The maximum length of sanitized body text.
pub const MAX_BODY_TEXT_LENGTH: usize = 100_000;

/// Removes control characters and line breaks from a header value.
///
/// Runs of whitespace collapse to a single space, and the result is capped so a
/// value cannot smuggle headers or exhaust memory.
pub fn sanitize_header_value(value: &str, max_length: usize) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if character.is_control() || character == '\u{7f}' {
                ' '
            } else {
                character
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate(collapsed, max_length)
}

/// Normalizes body text and caps its length.
///
/// CRLF and CR become LF, control characters other than tab and newline are
/// dropped, runs of blank lines collapse to a single blank line, trailing
/// whitespace on each line is removed, and the whole value is trimmed.
pub fn sanitize_text(text: &str, max_length: usize) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<String> = Vec::new();
    for line in normalized.split('\n') {
        let filtered: String = line
            .chars()
            .filter(|character| {
                !(character.is_control() && *character != '\t') && *character != '\u{7f}'
            })
            .collect();
        lines.push(filtered.trim_end().to_string());
    }
    // Collapse runs of blank lines to a single blank line.
    let mut collapsed: Vec<String> = Vec::with_capacity(lines.len());
    let mut previous_blank = false;
    for line in lines {
        let blank = line.is_empty();
        if blank && previous_blank {
            continue;
        }
        previous_blank = blank;
        collapsed.push(line);
    }
    let joined = collapsed.join("\n");
    truncate(joined.trim().to_string(), max_length)
}

/// The first mailbox in the `From` header, canonicalized, or `None`.
pub fn sanitize_sender(message: &MessageParts) -> Option<String> {
    let value = message.headers.get("From")?;
    let candidate = match (value.find('<'), value.find('>')) {
        (Some(start), Some(end)) if end > start => &value[start + 1..end],
        _ => value,
    }
    .trim();
    CanonicalAddress::parse(candidate)
        .ok()
        .map(|address| address.as_str().to_string())
}

/// The sanitized `Subject`, or `None` when absent or empty.
pub fn sanitize_subject(message: &MessageParts) -> Option<String> {
    let value = message.headers.get("Subject")?;
    let cleaned = sanitize_header_value(value, MAX_HEADER_VALUE_LENGTH);
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// The sanitized plain-text body of a message.
///
/// A multipart message prefers its `text/plain` part; an HTML part is reduced
/// to text. Transfer encodings are decoded. The result is normalized and
/// capped, and is never logged.
pub fn extract_text_body(message: &MessageParts) -> String {
    let content_type = message
        .headers
        .get("Content-Type")
        .unwrap_or("text/plain")
        .to_ascii_lowercase();
    let encoding = message.headers.get("Content-Transfer-Encoding");

    if content_type.starts_with("multipart/") {
        let header = message.headers.get("Content-Type").unwrap_or("");
        return match boundary_of(header) {
            Some(boundary) => sanitize_text(
                &body_from_multipart(&message.body, &boundary),
                MAX_BODY_TEXT_LENGTH,
            ),
            None => String::new(),
        };
    }

    let decoded = decode_transfer_encoding(&message.body, encoding);
    if content_type.starts_with("text/html") {
        sanitize_text(&strip_html(&decoded), MAX_BODY_TEXT_LENGTH)
    } else {
        sanitize_text(&decoded, MAX_BODY_TEXT_LENGTH)
    }
}

fn truncate(mut value: String, max_length: usize) -> String {
    if value.chars().count() > max_length {
        value = value.chars().take(max_length).collect();
    }
    value
}

/// Extracts the `boundary` parameter from a `Content-Type` value.
fn boundary_of(content_type: &str) -> Option<String> {
    let lower = content_type.to_ascii_lowercase();
    let index = lower.find("boundary=")?;
    let rest = &content_type[index + "boundary=".len()..];
    let value = rest.trim_start();
    if let Some(stripped) = value.strip_prefix('"') {
        let end = stripped.find('"')?;
        Some(stripped[..end].to_string())
    } else {
        let end = value
            .find(|character: char| character == ';' || character.is_whitespace())
            .unwrap_or(value.len());
        Some(value[..end].to_string())
    }
}

fn decode_transfer_encoding(body: &[u8], encoding: Option<&str>) -> String {
    let normalized = encoding.unwrap_or("7bit").trim().to_ascii_lowercase();
    match normalized.as_str() {
        "base64" => {
            let filtered: String = String::from_utf8_lossy(body)
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect();
            match BASE64.decode(filtered.as_bytes()) {
                Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                Err(_) => String::from_utf8_lossy(body).into_owned(),
            }
        }
        "quoted-printable" => decode_quoted_printable(body),
        _ => String::from_utf8_lossy(body).into_owned(),
    }
}

fn decode_quoted_printable(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body).into_owned();
    let mut bytes = Vec::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let character = chars[index];
        if character == '=' {
            if index + 1 < chars.len() && chars[index + 1] == '\n' {
                index += 2;
                continue;
            }
            if index + 2 < chars.len() && chars[index + 1] == '\r' && chars[index + 2] == '\n' {
                index += 3;
                continue;
            }
            if index + 2 < chars.len() {
                let hex: String = chars[index + 1..=index + 2].iter().collect();
                if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                    bytes.push(byte);
                    index += 3;
                    continue;
                }
            }
        }
        let mut buffer = [0u8; 4];
        bytes.extend_from_slice(character.encode_utf8(&mut buffer).as_bytes());
        index += 1;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn strip_html(html: &str) -> String {
    let mut output = String::with_capacity(html.len());
    let mut index = 0;
    let bytes: Vec<char> = html.chars().collect();
    while index < bytes.len() {
        if bytes[index] == '<' {
            let rest: String = bytes[index..].iter().collect();
            let lower = rest.to_ascii_lowercase();
            if lower.starts_with("<script") {
                if let Some(end) = lower.find("</script>") {
                    index += end + "</script>".len();
                    continue;
                }
            }
            if lower.starts_with("<style") {
                if let Some(end) = lower.find("</style>") {
                    index += end + "</style>".len();
                    continue;
                }
            }
            if let Some(close) = rest.find('>') {
                let tag: String = rest[..close].to_ascii_lowercase();
                let name = tag
                    .trim_start_matches('<')
                    .trim_start_matches('/')
                    .split(|character: char| character.is_whitespace() || character == '/')
                    .next()
                    .unwrap_or("");
                if name == "br"
                    || matches!(
                        name,
                        "p" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                    )
                {
                    output.push('\n');
                }
                index += close + 1;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    decode_entities(&output)
}

fn decode_entities(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let chars: Vec<char> = value.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '&' {
            let rest: String = chars[index..].iter().collect();
            if let Some(end) = rest.find(';') {
                if end <= 10 {
                    let entity: String = rest[1..end].to_ascii_lowercase();
                    let replacement = match entity.as_str() {
                        "amp" => Some("&"),
                        "lt" => Some("<"),
                        "gt" => Some(">"),
                        "quot" => Some("\""),
                        "apos" | "#39" => Some("'"),
                        "nbsp" => Some(" "),
                        _ => None,
                    };
                    if let Some(replacement) = replacement {
                        output.push_str(replacement);
                        index += end + 1;
                        continue;
                    }
                }
            }
        }
        output.push(chars[index]);
        index += 1;
    }
    output
}

fn body_from_multipart(body: &[u8], boundary: &str) -> String {
    let text = String::from_utf8_lossy(body);
    let marker = format!("--{boundary}");
    let mut parts = Vec::new();
    for (position, segment) in text.split(&marker).enumerate() {
        if position == 0 {
            continue;
        }
        let trimmed = segment.trim_matches(['\r', '\n']);
        if trimmed.is_empty() || trimmed == "--" {
            continue;
        }
        parts.push(trimmed.to_string());
    }
    let mut html: Option<String> = None;
    for part in &parts {
        let parsed = MessageParts::parse(part.as_bytes());
        let content_type = parsed
            .headers
            .get("Content-Type")
            .unwrap_or("text/plain")
            .split(';')
            .next()
            .unwrap_or("text/plain")
            .trim()
            .to_ascii_lowercase();
        let encoding = parsed.headers.get("Content-Transfer-Encoding");
        let decoded = decode_transfer_encoding(&parsed.body, encoding);
        if content_type == "text/plain" {
            return decoded;
        }
        if content_type == "text/html" && html.is_none() {
            html = Some(strip_html(&decoded));
        }
    }
    html.unwrap_or_default()
}

/// Addresses named in a header value, canonicalized.
///
/// Exposed for the outbound identity check, which compares `From`, `Sender`,
/// and `Reply-To` mailboxes against the selected identity.
pub fn header_mailboxes(value: &str) -> Vec<CanonicalAddress> {
    mailbox_addresses(value)
}

#[cfg(test)]
mod tests {
    use super::{
        extract_text_body, sanitize_header_value, sanitize_sender, sanitize_subject, sanitize_text,
    };
    use crate::mail::headers::MessageParts;

    #[test]
    fn header_values_lose_control_characters_and_line_breaks() {
        let cleaned = sanitize_header_value("Hello\r\nBcc: leak@example.org", 998);
        assert!(!cleaned.contains('\r'));
        assert!(!cleaned.contains('\n'));
        assert!(cleaned.starts_with("Hello"));
    }

    #[test]
    fn text_normalizes_line_endings_and_blank_runs() {
        assert_eq!(sanitize_text("a\r\n\r\n\r\n\r\nb", 1000), "a\n\nb");
        assert_eq!(sanitize_text("  spaced  \n", 1000), "spaced");
    }

    #[test]
    fn sender_uses_the_angle_address() {
        let message = MessageParts::parse(b"From: Sender Name <sender@example.net>\r\n\r\nbody");
        assert_eq!(
            sanitize_sender(&message).as_deref(),
            Some("sender@example.net")
        );
    }

    #[test]
    fn subject_is_sanitized_and_empty_becomes_none() {
        let message = MessageParts::parse(b"Subject:   \r\n\r\nbody");
        assert_eq!(sanitize_subject(&message), None);
        let message = MessageParts::parse(b"Subject: Hi\r\n\r\nbody");
        assert_eq!(sanitize_subject(&message).as_deref(), Some("Hi"));
    }

    #[test]
    fn html_bodies_reduce_to_text() {
        let message = MessageParts::parse(
            b"Content-Type: text/html; charset=utf-8\r\n\r\n<p>Hello <b>there</b></p><script>alert(1)</script><br>Bye",
        );
        assert_eq!(extract_text_body(&message), "Hello there\n\nBye");
    }

    #[test]
    fn quoted_printable_bodies_decode() {
        let message = MessageParts::parse(
            b"Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\ncaf=C3=A9 and more",
        );
        assert_eq!(extract_text_body(&message), "café and more");
    }

    #[test]
    fn multipart_prefers_the_plain_part() {
        let raw = b"Content-Type: multipart/alternative; boundary=\"bnd\"\r\n\r\n\
--bnd\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nplain body\r\n\
--bnd\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>html body</p>\r\n--bnd--";
        let message = MessageParts::parse(raw);
        assert_eq!(extract_text_body(&message), "plain body");
    }
}
