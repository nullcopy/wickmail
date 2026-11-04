//! Alias address parsing and canonicalization.
//!
//! Lookup is case-insensitive. The local part is canonicalized to lowercase
//! ASCII and the domain to lowercase ASCII or punycode, and uniqueness is
//! enforced on the canonical address. Plus addressing is not supported in v1:
//! a `+` tag is preserved in the canonical form, so a tagged recipient never
//! matches an alias address.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Why an address could not be parsed or canonicalized.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum AddressError {
    /// The input has no `@` separating the local part from the domain.
    #[error("address is missing an '@' separator")]
    MissingSeparator,
    /// The local part or domain is empty.
    #[error("address has an empty local part or domain")]
    EmptyPart,
    /// The local part is not supported in v1.
    #[error("unsupported local part: {0:?}")]
    UnsupportedLocalPart(String),
    /// The domain could not be canonicalized.
    #[error("invalid domain: {0:?}")]
    InvalidDomain(String),
}

/// A full email address in canonical form.
///
/// Equality and hashing use the canonical form, so lookups are
/// case-insensitive and stable across input forms.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CanonicalAddress(String);

impl CanonicalAddress {
    /// Parses and canonicalizes a full address.
    pub fn parse(input: &str) -> Result<Self, AddressError> {
        let (local, domain) = input
            .rsplit_once('@')
            .ok_or(AddressError::MissingSeparator)?;
        if local.is_empty() || domain.is_empty() {
            return Err(AddressError::EmptyPart);
        }
        let local = canonicalize_local_part(local)?;
        let domain = Domain::parse(domain)?;
        Ok(Self(format!("{local}@{}", domain.as_str())))
    }

    /// Builds a canonical address from a local part and a canonical domain.
    pub fn from_parts(local: &str, domain: &Domain) -> Result<Self, AddressError> {
        let local = canonicalize_local_part(local)?;
        Ok(Self(format!("{local}@{}", domain.as_str())))
    }

    /// The canonical address as a string.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The canonical local part.
    pub fn local_part(&self) -> &str {
        self.0.split('@').next().unwrap_or_default()
    }

    /// The canonical domain.
    pub fn domain(&self) -> &str {
        self.0.split('@').next_back().unwrap_or_default()
    }

    /// True when the address carries a `+` tag, which v1 does not support.
    pub fn has_plus_tag(&self) -> bool {
        self.local_part().contains('+')
    }
}

impl fmt::Display for CanonicalAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for CanonicalAddress {
    type Err = AddressError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl rusqlite::types::FromSql for CanonicalAddress {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        let text = value.as_str()?;
        CanonicalAddress::parse(text)
            .map_err(|error| rusqlite::types::FromSqlError::Other(Box::new(error)))
    }
}

impl rusqlite::types::ToSql for CanonicalAddress {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        Ok(rusqlite::types::ToSqlOutput::from(self.0.as_str()))
    }
}

/// A canonical email domain: lowercase ASCII or punycode.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Domain(String);

impl Domain {
    /// Parses and canonicalizes a domain.
    ///
    /// Unicode domains are converted to punycode, so `münchen.de` and
    /// `xn--mnchen-3ya.de` canonicalize to the same value.
    pub fn parse(input: &str) -> Result<Self, AddressError> {
        let trimmed = input.strip_suffix('.').unwrap_or(input);
        if trimmed.is_empty() {
            return Err(AddressError::EmptyPart);
        }
        if trimmed.chars().any(char::is_whitespace) {
            return Err(AddressError::InvalidDomain(input.to_string()));
        }
        let ascii = idna::domain_to_ascii(trimmed)
            .map_err(|_| AddressError::InvalidDomain(input.to_string()))?;
        if ascii.is_empty() || !ascii.is_ascii() {
            return Err(AddressError::InvalidDomain(input.to_string()));
        }
        Ok(Self(ascii.to_ascii_lowercase()))
    }

    /// The canonical domain as a string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Domain {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for Domain {
    type Err = AddressError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

fn canonicalize_local_part(local: &str) -> Result<String, AddressError> {
    if !local.is_ascii() {
        return Err(AddressError::UnsupportedLocalPart(local.to_string()));
    }
    let lowered = local.to_ascii_lowercase();
    let allowed = lowered.chars().all(|character| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '.' | '_' | '-' | '+')
    });
    if !allowed || lowered.starts_with('.') || lowered.ends_with('.') || lowered.contains("..") {
        return Err(AddressError::UnsupportedLocalPart(local.to_string()));
    }
    Ok(lowered)
}

#[cfg(test)]
mod tests {
    use super::{AddressError, CanonicalAddress, Domain};

    #[test]
    fn lowercases_local_part_and_domain() {
        let address = CanonicalAddress::parse("Green.Farm@Example.COM").unwrap();
        assert_eq!(address.as_str(), "green.farm@example.com");
        assert_eq!(address.local_part(), "green.farm");
        assert_eq!(address.domain(), "example.com");
    }

    #[test]
    fn canonical_forms_compare_equal() {
        let first = CanonicalAddress::parse("Green.Farm@Example.com").unwrap();
        let second = CanonicalAddress::parse("green.farm@example.com").unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn converts_unicode_domains_to_punycode() {
        let address = CanonicalAddress::parse("green.farm@münchen.de").unwrap();
        assert_eq!(address.as_str(), "green.farm@xn--mnchen-3ya.de");
        assert_eq!(
            Domain::parse("MÜNCHEN.DE").unwrap(),
            Domain::parse("xn--mnchen-3ya.de").unwrap()
        );
    }

    #[test]
    fn plus_tagged_recipients_do_not_match_aliases() {
        let alias = CanonicalAddress::parse("green.farm@example.com").unwrap();
        let tagged = CanonicalAddress::parse("green.farm+orders@example.com").unwrap();
        assert_ne!(alias, tagged);
        assert!(tagged.has_plus_tag());
        assert!(!alias.has_plus_tag());
    }

    #[test]
    fn strips_one_trailing_dot_from_domain() {
        let address = CanonicalAddress::parse("green.farm@example.com.").unwrap();
        assert_eq!(address.as_str(), "green.farm@example.com");
    }

    #[test]
    fn rejects_malformed_addresses() {
        assert_eq!(
            CanonicalAddress::parse("no-separator").unwrap_err(),
            AddressError::MissingSeparator
        );
        assert_eq!(
            CanonicalAddress::parse("@example.com").unwrap_err(),
            AddressError::EmptyPart
        );
        assert!(CanonicalAddress::parse("green..farm@example.com").is_err());
        assert!(CanonicalAddress::parse("green farm@example.com").is_err());
    }
}
