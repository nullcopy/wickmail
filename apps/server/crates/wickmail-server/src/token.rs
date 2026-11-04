//! Scoped, hashed, expirable, revocable API tokens.
//!
//! Tokens are shown once at creation and stored only as a SHA-256 hash. They
//! carry a scope set that the management API enforces per endpoint. Tokens are
//! programmatic credentials: they are never stored in browser storage and are
//! not accepted for session-only operations such as token management.

use std::fmt;
use std::str::FromStr;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::identity::{UserId, hash_secret, random_secret};
use crate::timestamp::Timestamp;

/// Prefix on every issued API token.
pub const TOKEN_PREFIX: &str = "wmk";

/// A capability a token may be granted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Scope {
    /// Read aliases and their events.
    #[serde(rename = "aliases:read")]
    AliasesRead,
    /// Create and mutate aliases.
    #[serde(rename = "aliases:write")]
    AliasesWrite,
    /// Read quarantine metadata and bodies.
    #[serde(rename = "quarantine:read")]
    QuarantineRead,
    /// Recover and delete quarantined messages.
    #[serde(rename = "quarantine:write")]
    QuarantineWrite,
    /// Read reply context for a message.
    #[serde(rename = "messages:read")]
    MessagesRead,
    /// Send a reply through an alias.
    #[serde(rename = "messages:reply")]
    MessagesReply,
}

impl Scope {
    /// Every scope, in a stable order.
    pub const ALL: [Scope; 6] = [
        Scope::AliasesRead,
        Scope::AliasesWrite,
        Scope::QuarantineRead,
        Scope::QuarantineWrite,
        Scope::MessagesRead,
        Scope::MessagesReply,
    ];

    /// The wire representation, such as `aliases:read`.
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::AliasesRead => "aliases:read",
            Scope::AliasesWrite => "aliases:write",
            Scope::QuarantineRead => "quarantine:read",
            Scope::QuarantineWrite => "quarantine:write",
            Scope::MessagesRead => "messages:read",
            Scope::MessagesReply => "messages:reply",
        }
    }
}

impl fmt::Display for Scope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Scope {
    type Err = TokenError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Scope::ALL
            .into_iter()
            .find(|scope| scope.as_str() == value)
            .ok_or_else(|| TokenError::UnknownScope(value.to_string()))
    }
}

/// A set of scopes.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ScopeSet(Vec<Scope>);

impl ScopeSet {
    /// Builds a set from an iterator, rejecting duplicates.
    pub fn new<I>(scopes: I) -> Result<Self, TokenError>
    where
        I: IntoIterator<Item = Scope>,
    {
        let mut set = Vec::new();
        for scope in scopes {
            if set.contains(&scope) {
                return Err(TokenError::DuplicateScope(scope));
            }
            set.push(scope);
        }
        Ok(Self(set))
    }

    /// Every scope.
    pub fn all() -> Self {
        Self(Scope::ALL.to_vec())
    }

    /// Whether the set contains `scope`.
    pub fn contains(&self, scope: Scope) -> bool {
        self.0.contains(&scope)
    }

    /// The scopes, in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = Scope> + '_ {
        self.0.iter().copied()
    }

    /// Whether the set is empty.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The number of scopes.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// A comma-separated representation for storage.
    pub fn to_storage(&self) -> String {
        self.0
            .iter()
            .map(|scope| scope.as_str())
            .collect::<Vec<_>>()
            .join(",")
    }

    /// Parses the comma-separated representation used in storage.
    pub fn from_storage(value: &str) -> Result<Self, TokenError> {
        let mut scopes = Vec::new();
        for part in value.split(',') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            scopes.push(part.parse()?);
        }
        ScopeSet::new(scopes)
    }
}

/// Stable identifier for an API token.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TokenId(Uuid);

impl TokenId {
    /// Generates a new random identifier.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    /// Wraps an existing UUID.
    pub fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }
}

impl Default for TokenId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for TokenId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for TokenId {
    type Err = uuid::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(value).map(Self)
    }
}

impl rusqlite::types::FromSql for TokenId {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        let text = value.as_str()?;
        TokenId::from_str(text)
            .map_err(|error| rusqlite::types::FromSqlError::Other(Box::new(error)))
    }
}

impl rusqlite::types::ToSql for TokenId {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        Ok(rusqlite::types::ToSqlOutput::from(self.0.to_string()))
    }
}

/// A stored API token. The secret is never stored, only its hash.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiToken {
    /// Stable identifier.
    pub id: TokenId,
    /// Owning user.
    pub user_id: UserId,
    /// User-facing name.
    pub name: String,
    /// Non-secret display prefix, shown in lists.
    pub prefix: String,
    /// Granted scopes.
    pub scopes: ScopeSet,
    /// When the token was created.
    pub created_at: Timestamp,
    /// Absolute expiry, or `None` for no expiry.
    pub expires_at: Option<Timestamp>,
    /// When the token was revoked.
    pub revoked_at: Option<Timestamp>,
    /// Most recent authenticated use.
    pub last_used_at: Option<Timestamp>,
    /// SHA-256 hash of the token secret.
    #[serde(skip)]
    pub token_hash: String,
}

impl ApiToken {
    /// Whether the token is live at `now`.
    pub fn is_live(&self, now: Timestamp) -> bool {
        self.revoked_at.is_none() && self.expires_at.is_none_or(|expires| expires > now)
    }
}

/// A newly issued token: the plaintext (shown once) and the stored record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssuedToken {
    /// The plaintext token, returned to the caller exactly once.
    pub token: String,
    /// The stored record.
    pub record: ApiToken,
}

/// Token failures.
#[derive(Debug, Error)]
pub enum TokenError {
    /// An unknown scope string was supplied.
    #[error("unknown scope: {0}")]
    UnknownScope(String),
    /// A scope was supplied twice.
    #[error("duplicate scope: {0}")]
    DuplicateScope(Scope),
    /// The token string is malformed.
    #[error("malformed token")]
    Malformed,
    /// Storage failure.
    #[error(transparent)]
    Store(#[from] crate::db::StoreError),
}

/// Hashes a token for storage and lookup.
pub fn token_hash(token: &str) -> String {
    hash_secret(token)
}

/// Splits a token into its display prefix and secret.
///
/// A token has the form `wmk_<prefix>_<secret>`.
pub fn split_token(token: &str) -> Option<(&str, &str)> {
    let mut parts = token.splitn(3, '_');
    let scheme = parts.next()?;
    if scheme != TOKEN_PREFIX {
        return None;
    }
    let prefix = parts.next()?;
    let secret = parts.next()?;
    if prefix.is_empty() || secret.is_empty() {
        return None;
    }
    Some((prefix, secret))
}

/// Issues a new token with the given name, scopes, and expiry.
pub fn issue_token(
    user_id: UserId,
    name: impl Into<String>,
    scopes: ScopeSet,
    expires_at: Option<Timestamp>,
    now: Timestamp,
) -> IssuedToken {
    let prefix = random_secret(4);
    let secret = random_secret(32);
    let token = format!("{TOKEN_PREFIX}_{prefix}_{secret}");
    let record = ApiToken {
        id: TokenId::new(),
        user_id,
        name: name.into(),
        prefix,
        scopes,
        created_at: now,
        expires_at,
        revoked_at: None,
        last_used_at: None,
        token_hash: token_hash(&token),
    };
    IssuedToken { token, record }
}

/// Base64url-decodes without padding, exposed for tests.
#[allow(dead_code)]
fn decode_secret(value: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(value).ok()
}

#[cfg(test)]
mod tests {
    use super::{ApiToken, Scope, ScopeSet, TokenError, issue_token, split_token, token_hash};
    use crate::identity::UserId;
    use crate::timestamp::Timestamp;

    fn at(value: &str) -> Timestamp {
        value.parse().unwrap()
    }

    #[test]
    fn scopes_round_trip_through_storage_and_json() {
        let set = ScopeSet::new([Scope::AliasesRead, Scope::MessagesReply]).unwrap();
        assert!(set.contains(Scope::AliasesRead));
        assert!(!set.contains(Scope::AliasesWrite));
        assert_eq!(set.to_storage(), "aliases:read,messages:reply");
        assert_eq!(
            ScopeSet::from_storage("aliases:read,messages:reply").unwrap(),
            set
        );
        let json = serde_json::to_string(&set).unwrap();
        assert_eq!(json, r#"["aliases:read","messages:reply"]"#);
        let decoded: ScopeSet = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, set);
    }

    #[test]
    fn duplicate_and_unknown_scopes_are_rejected() {
        assert!(matches!(
            ScopeSet::new([Scope::AliasesRead, Scope::AliasesRead]),
            Err(TokenError::DuplicateScope(_))
        ));
        assert!(matches!(
            ScopeSet::from_storage("aliases:read,bogus"),
            Err(TokenError::UnknownScope(_))
        ));
    }

    #[test]
    fn issued_tokens_are_shown_once_and_stored_as_a_hash() {
        let issued = issue_token(
            UserId::new(),
            "ci",
            ScopeSet::new([Scope::AliasesRead]).unwrap(),
            None,
            at("2026-01-01T00:00:00Z"),
        );
        assert!(issued.token.starts_with("wmk_"));
        let (prefix, _secret) = split_token(&issued.token).unwrap();
        assert_eq!(prefix, issued.record.prefix);
        assert_eq!(issued.record.token_hash, token_hash(&issued.token));
        assert!(!issued.record.token_hash.contains(&issued.token));
    }

    #[test]
    fn malformed_tokens_are_rejected() {
        assert!(split_token("nope").is_none());
        assert!(split_token("wmk_only").is_none());
        assert!(split_token("wmk__x").is_none());
    }

    #[test]
    fn liveness_honors_expiry_and_revocation() {
        let mut issued = issue_token(
            UserId::new(),
            "ci",
            ScopeSet::all(),
            Some(at("2026-02-01T00:00:00Z")),
            at("2026-01-01T00:00:00Z"),
        );
        let record: &mut ApiToken = &mut issued.record;
        assert!(record.is_live(at("2026-01-15T00:00:00Z")));
        assert!(!record.is_live(at("2026-02-02T00:00:00Z")));
        record.revoked_at = Some(at("2026-01-10T00:00:00Z"));
        assert!(!record.is_live(at("2026-01-15T00:00:00Z")));
    }
}
