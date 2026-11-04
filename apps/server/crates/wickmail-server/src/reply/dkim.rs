//! DKIM signing and DMARC alignment for outbound replies.
//!
//! Replies are signed with the alias domain's key using `relaxed/relaxed`
//! canonicalization and `rsa-sha256`. The signing domain is the `From` domain,
//! so the signature is DMARC-aligned. Verification checks the body hash and the
//! header signature against a public key; it performs no DNS lookup.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use rsa::pkcs1v15::{Signature, SigningKey, VerifyingKey};
use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey};
use rsa::signature::{SignatureEncoding, Signer, Verifier};
use rsa::{RsaPrivateKey, RsaPublicKey};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::address::Domain;
use crate::mail::headers::MessageParts;
use crate::timestamp::Timestamp;

/// The headers signed by default, when present in the message.
pub const DEFAULT_DKIM_HEADERS: &[&str] = &[
    "from",
    "to",
    "subject",
    "date",
    "message-id",
    "in-reply-to",
    "references",
    "mime-version",
    "content-type",
    "content-transfer-encoding",
];

/// Why DKIM signing or verification failed.
#[derive(Debug, Error)]
pub enum DkimError {
    /// The private key could not be read.
    #[error("invalid DKIM private key: {0}")]
    Key(String),
    /// The message could not be signed.
    #[error("DKIM signing failed: {0}")]
    Sign(String),
}

/// Signs outbound messages with one alias-domain key.
pub struct DkimSigner {
    domain: Domain,
    selector: String,
    private_key: RsaPrivateKey,
}

impl DkimSigner {
    /// Loads a signer from a PKCS#8 or PKCS#1 PEM private key.
    pub fn from_pem(
        domain: Domain,
        selector: impl Into<String>,
        pem: &str,
    ) -> Result<Self, DkimError> {
        let private_key = RsaPrivateKey::from_pkcs8_pem(pem)
            .or_else(|_| {
                use rsa::pkcs1::DecodeRsaPrivateKey;
                RsaPrivateKey::from_pkcs1_pem(pem)
            })
            .map_err(|error| DkimError::Key(error.to_string()))?;
        Ok(Self {
            domain,
            selector: selector.into(),
            private_key,
        })
    }

    /// Builds a signer from an already-parsed key.
    pub fn from_private_key(
        domain: Domain,
        selector: impl Into<String>,
        private_key: RsaPrivateKey,
    ) -> Self {
        Self {
            domain,
            selector: selector.into(),
            private_key,
        }
    }

    /// The signing domain.
    pub fn domain(&self) -> &Domain {
        &self.domain
    }

    /// The DNS selector published for the key.
    pub fn selector(&self) -> &str {
        &self.selector
    }

    /// DKIM-signs a message and returns the signed bytes.
    pub fn sign(&self, raw: &[u8], now: Timestamp) -> Result<Vec<u8>, DkimError> {
        sign_message(
            raw,
            &self.domain,
            &self.selector,
            &self.private_key,
            now.unix_millis() / 1000,
        )
    }
}

/// Signs `raw` and prepends the `DKIM-Signature` header.
fn sign_message(
    raw: &[u8],
    domain: &Domain,
    selector: &str,
    private_key: &RsaPrivateKey,
    timestamp_seconds: i64,
) -> Result<Vec<u8>, DkimError> {
    let message = MessageParts::parse(raw);

    let mut signed_names: Vec<String> = Vec::new();
    let mut canonical_headers = String::new();
    for name in DEFAULT_DKIM_HEADERS {
        if let Some(header) = last_header(&message, name) {
            canonical_headers.push_str(&canonicalize_header_field(name, &header.value));
            canonical_headers.push_str("\r\n");
            signed_names.push((*name).to_string());
        }
    }
    if !signed_names.iter().any(|name| name == "from") {
        return Err(DkimError::Sign("message has no From header".to_string()));
    }

    let body_hash = body_hash(&message.body);

    let empty_value = format!(
        "v=1; a=rsa-sha256; c=relaxed/relaxed; d={}; s={}; t={timestamp_seconds}; h={}; bh={body_hash}; b=",
        domain.as_str(),
        selector,
        signed_names.join(":")
    );
    let signing_input = format!(
        "{canonical_headers}{}",
        canonicalize_header_field("DKIM-Signature", &empty_value)
    );

    let signing_key = SigningKey::<Sha256>::new(private_key.clone());
    let signature = signing_key.sign(signing_input.as_bytes());
    let signature_base64 = BASE64.encode(signature.to_bytes());

    let signed_value = format!(
        "v=1; a=rsa-sha256; c=relaxed/relaxed; d={}; s={}; t={timestamp_seconds}; h={}; bh={body_hash}; b={signature_base64}",
        domain.as_str(),
        selector,
        signed_names.join(":")
    );

    let mut output = Vec::with_capacity(raw.len() + signed_value.len() + 20);
    output.extend_from_slice(b"DKIM-Signature: ");
    output.extend_from_slice(signed_value.as_bytes());
    output.extend_from_slice(b"\r\n");
    output.extend_from_slice(raw);
    Ok(output)
}

/// The result of verifying a DKIM signature.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DkimVerification {
    /// Whether the body hash and header signature both verified.
    pub valid: bool,
    /// The signing domain from `d=`.
    pub domain: Option<String>,
    /// The selector from `s=`.
    pub selector: Option<String>,
    /// Why verification failed, or `None` on success.
    pub reason: Option<String>,
}

/// Verifies the DKIM signature on `raw` against `public_key`.
///
/// The body hash and header signature are both checked. No DNS lookup is
/// performed, so the caller must supply the public key that matches the
/// published selector.
pub fn verify_dkim(raw: &[u8], public_key: &RsaPublicKey) -> DkimVerification {
    let message = MessageParts::parse(raw);
    let Some(value) = message.headers.get("DKIM-Signature") else {
        return invalid(None, None, "missing DKIM-Signature");
    };

    let tags = parse_tags(value);
    let domain = tag(&tags, "d");
    let selector = tag(&tags, "s");
    let (Some(expected_body_hash), Some(signature), Some(header_list)) =
        (tag(&tags, "bh"), tag(&tags, "b"), tag(&tags, "h"))
    else {
        return invalid(domain, selector, "incomplete DKIM-Signature");
    };

    if body_hash(&message.body) != expected_body_hash {
        return invalid(domain, selector, "body hash mismatch");
    }

    let mut canonical_headers = String::new();
    for name in header_list.split(':') {
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        if let Some(header) = last_header(&message, &name) {
            canonical_headers.push_str(&canonicalize_header_field(&name, &header.value));
            canonical_headers.push_str("\r\n");
        }
    }

    let empty_value = value
        .split(';')
        .filter_map(|segment| {
            let (name, tag_value) = segment.split_once('=')?;
            let name = name.trim();
            if name.is_empty() {
                return None;
            }
            let tag_value = tag_value.trim();
            if name == "b" {
                Some(format!("{name}="))
            } else {
                Some(format!("{name}={tag_value}"))
            }
        })
        .collect::<Vec<_>>()
        .join("; ");
    let signing_input = format!(
        "{canonical_headers}{}",
        canonicalize_header_field("DKIM-Signature", &empty_value)
    );

    let Ok(signature_bytes) = BASE64.decode(signature.as_bytes()) else {
        return invalid(domain, selector, "invalid signature encoding");
    };
    let Ok(signature) = Signature::try_from(signature_bytes.as_slice()) else {
        return invalid(domain, selector, "invalid signature");
    };

    let verifying_key = VerifyingKey::<Sha256>::new(public_key.clone());
    match verifying_key.verify(signing_input.as_bytes(), &signature) {
        Ok(()) => DkimVerification {
            valid: true,
            domain,
            selector,
            reason: None,
        },
        Err(_) => invalid(domain, selector, "signature mismatch"),
    }
}

/// Loads a public key from a PKCS#8/SPKI or PKCS#1 PEM document.
pub fn public_key_from_pem(pem: &str) -> Result<RsaPublicKey, DkimError> {
    RsaPublicKey::from_public_key_pem(pem)
        .or_else(|_| {
            use rsa::pkcs1::DecodeRsaPublicKey;
            RsaPublicKey::from_pkcs1_pem(pem)
        })
        .map_err(|error| DkimError::Key(error.to_string()))
}

/// Whether a DKIM signing domain is DMARC-aligned with the `From` domain.
///
/// v1 uses strict alignment: the domains must be equal.
pub fn dmarc_aligned(from_domain: &str, dkim_domain: &str) -> bool {
    from_domain.trim().eq_ignore_ascii_case(dkim_domain.trim())
}

fn invalid(domain: Option<String>, selector: Option<String>, reason: &str) -> DkimVerification {
    DkimVerification {
        valid: false,
        domain,
        selector,
        reason: Some(reason.to_string()),
    }
}

fn last_header<'a>(
    message: &'a MessageParts,
    name: &str,
) -> Option<&'a crate::mail::headers::Header> {
    message
        .headers
        .entries()
        .iter()
        .rev()
        .find(|header| header.name.eq_ignore_ascii_case(name))
}

fn body_hash(body: &[u8]) -> String {
    let canonical = canonicalize_body_relaxed(body);
    BASE64.encode(Sha256::digest(canonical.as_bytes()))
}

/// Canonicalizes a header value with the DKIM relaxed algorithm.
fn canonicalize_header_value(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Canonicalizes a header field with the DKIM relaxed algorithm.
fn canonicalize_header_field(name: &str, value: &str) -> String {
    format!(
        "{}:{}",
        name.trim().to_ascii_lowercase(),
        canonicalize_header_value(value)
    )
}

/// Canonicalizes a body with the DKIM relaxed algorithm.
///
/// Whitespace within a line collapses to a single space, trailing whitespace
/// and trailing empty lines are removed, and a non-empty body ends with CRLF.
pub fn canonicalize_body_relaxed(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<String> = normalized
        .split('\n')
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect();
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\r\n", lines.join("\r\n"))
    }
}

fn parse_tags(value: &str) -> Vec<(String, String)> {
    value
        .split(';')
        .filter_map(|segment| {
            let (name, value) = segment.split_once('=')?;
            let name = name.trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some((name, value.trim().to_string()))
        })
        .collect()
}

fn tag(tags: &[(String, String)], name: &str) -> Option<String> {
    tags.iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.clone())
}

#[cfg(test)]
mod tests {
    use super::{
        DkimSigner, canonicalize_body_relaxed, dmarc_aligned, public_key_from_pem, verify_dkim,
    };
    use crate::address::Domain;
    use crate::timestamp::Timestamp;
    use rand::SeedableRng;
    use rand::rngs::StdRng;
    use rsa::pkcs8::{EncodePrivateKey, EncodePublicKey};
    use rsa::{RsaPrivateKey, RsaPublicKey};
    use std::sync::OnceLock;

    const MESSAGE: &[u8] = b"From: green.farm@example.com\r\n\
To: sender@example.net\r\n\
Subject: Re: Your order\r\n\
Date: Sun, 04 Jan 2026 00:00:00 +0000\r\n\
Message-ID: <reply@example.com>\r\n\
MIME-Version: 1.0\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Thanks for your order.\r\n";

    fn keys() -> &'static (RsaPrivateKey, RsaPublicKey) {
        static KEYS: OnceLock<(RsaPrivateKey, RsaPublicKey)> = OnceLock::new();
        KEYS.get_or_init(|| {
            let mut rng = StdRng::seed_from_u64(42);
            let private = RsaPrivateKey::new(&mut rng, 2048).unwrap();
            let public = RsaPublicKey::from(&private);
            (private, public)
        })
    }

    fn other_public() -> &'static RsaPublicKey {
        static OTHER: OnceLock<RsaPublicKey> = OnceLock::new();
        OTHER.get_or_init(|| {
            let mut rng = StdRng::seed_from_u64(7);
            RsaPublicKey::from(&RsaPrivateKey::new(&mut rng, 2048).unwrap())
        })
    }

    fn signer(private: &RsaPrivateKey) -> DkimSigner {
        DkimSigner::from_private_key(
            Domain::parse("example.com").unwrap(),
            "wickmail",
            private.clone(),
        )
    }

    #[test]
    fn signs_with_the_alias_domain_and_verifies() {
        let (private, public) = keys();
        let now: Timestamp = "2026-01-04T00:00:00Z".parse().unwrap();
        let signed = signer(private).sign(MESSAGE, now).unwrap();
        let text = String::from_utf8_lossy(&signed);
        assert!(text.starts_with("DKIM-Signature: v=1;"));
        assert!(text.contains("a=rsa-sha256"));
        assert!(text.contains("c=relaxed/relaxed"));
        assert!(text.contains("d=example.com"));
        assert!(text.contains("s=wickmail"));
        assert!(text.contains("h=from:"));

        let verified = verify_dkim(&signed, public);
        assert!(verified.valid, "{verified:?}");
        assert_eq!(verified.domain.as_deref(), Some("example.com"));
        assert_eq!(verified.selector.as_deref(), Some("wickmail"));
    }

    #[test]
    fn signature_is_dmarc_aligned() {
        let (private, public) = keys();
        let now: Timestamp = "2026-01-04T00:00:00Z".parse().unwrap();
        let signed = signer(private).sign(MESSAGE, now).unwrap();
        let verified = verify_dkim(&signed, public);
        assert!(dmarc_aligned("example.com", &verified.domain.unwrap()));
        assert!(!dmarc_aligned("example.com", "other.example"));
    }

    #[test]
    fn tampering_breaks_verification() {
        let (private, public) = keys();
        let now: Timestamp = "2026-01-04T00:00:00Z".parse().unwrap();
        let signed = signer(private).sign(MESSAGE, now).unwrap();
        let tampered =
            String::from_utf8_lossy(&signed).replace("Thanks for your order.", "Something else.");
        assert!(!verify_dkim(tampered.as_bytes(), public).valid);
    }

    #[test]
    fn a_different_key_does_not_verify() {
        let (private, _) = keys();
        let now: Timestamp = "2026-01-04T00:00:00Z".parse().unwrap();
        let signed = signer(private).sign(MESSAGE, now).unwrap();
        assert!(!verify_dkim(&signed, other_public()).valid);
    }

    #[test]
    fn loads_pem_keys() {
        let (private, public) = keys();
        let private_pem = private.to_pkcs8_pem(rsa::pkcs8::LineEnding::LF).unwrap();
        let public_pem = public
            .to_public_key_pem(rsa::pkcs8::LineEnding::LF)
            .unwrap();
        let signer = DkimSigner::from_pem(
            Domain::parse("example.com").unwrap(),
            "wickmail",
            &private_pem,
        )
        .unwrap();
        let public = public_key_from_pem(&public_pem).unwrap();
        let now: Timestamp = "2026-01-04T00:00:00Z".parse().unwrap();
        let signed = signer.sign(MESSAGE, now).unwrap();
        assert!(verify_dkim(&signed, &public).valid);
    }

    #[test]
    fn relaxed_body_canonicalization_matches_rfc6376() {
        assert_eq!(canonicalize_body_relaxed(b"a  b \r\n\r\n\r\n"), "a b\r\n");
        assert_eq!(canonicalize_body_relaxed(b""), "");
    }
}
