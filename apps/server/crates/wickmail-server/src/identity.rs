//! Management identity: the single user, Argon2id passwords, revocable
//! server-side sessions, one-time recovery codes, passkeys, and the separate
//! mail credential.
//!
//! Management authentication is deliberately separate from the Dovecot mail
//! credential. A leaked mail client credential cannot change alias policy, and
//! a leaked management session cannot read mail over IMAP. See
//! [ADR 0009](../../docs/decisions/0009-authentication-and-bootstrap.md).
//!
//! First run is bootstrapped from the CLI: the operator creates the user and
//! receives a single-use setup token. There are no default credentials.
//! Account recovery is local, through the CLI or one-time recovery codes,
//! never through email.

use std::fmt;
use std::str::FromStr;

use argon2::Argon2;
use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::clock::SharedClock;
use crate::db::{Store, StoreError};
use crate::timestamp::Timestamp;

/// Lifetime of a management session: 30 days.
pub const SESSION_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;

/// Lifetime of a single-use setup token: 24 hours.
pub const SETUP_TOKEN_TTL_SECONDS: i64 = 24 * 60 * 60;

/// Number of one-time recovery codes generated at a time.
pub const RECOVERY_CODE_COUNT: usize = 10;

/// Minimum accepted management password length.
pub const MIN_PASSWORD_LENGTH: usize = 12;

/// Stable identifier for the single management user.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct UserId(Uuid);

impl UserId {
    /// Generates a new time-ordered identifier.
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    /// Wraps an existing UUID.
    pub fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }

    /// The underlying UUID.
    pub fn as_uuid(self) -> Uuid {
        self.0
    }
}

impl Default for UserId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for UserId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for UserId {
    type Err = uuid::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(value).map(Self)
    }
}

impl rusqlite::types::FromSql for UserId {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        let text = value.as_str()?;
        UserId::from_str(text)
            .map_err(|error| rusqlite::types::FromSqlError::Other(Box::new(error)))
    }
}

impl rusqlite::types::ToSql for UserId {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        Ok(rusqlite::types::ToSqlOutput::from(self.0.to_string()))
    }
}

/// Stable identifier for a management session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(Uuid);

impl SessionId {
    /// Generates a new random identifier.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    /// Wraps an existing UUID.
    pub fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }

    /// The underlying UUID.
    pub fn as_uuid(self) -> Uuid {
        self.0
    }
}

impl Default for SessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for SessionId {
    type Err = uuid::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(value).map(Self)
    }
}

impl rusqlite::types::FromSql for SessionId {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        let text = value.as_str()?;
        SessionId::from_str(text)
            .map_err(|error| rusqlite::types::FromSqlError::Other(Box::new(error)))
    }
}

impl rusqlite::types::ToSql for SessionId {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        Ok(rusqlite::types::ToSqlOutput::from(self.0.to_string()))
    }
}

/// Stable identifier for a one-time recovery code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RecoveryCodeId(Uuid);

impl RecoveryCodeId {
    /// Generates a new random identifier.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    /// Wraps an existing UUID.
    pub fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }
}

impl Default for RecoveryCodeId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for RecoveryCodeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for RecoveryCodeId {
    type Err = uuid::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(value).map(Self)
    }
}

impl rusqlite::types::FromSql for RecoveryCodeId {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        let text = value.as_str()?;
        RecoveryCodeId::from_str(text)
            .map_err(|error| rusqlite::types::FromSqlError::Other(Box::new(error)))
    }
}

impl rusqlite::types::ToSql for RecoveryCodeId {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        Ok(rusqlite::types::ToSqlOutput::from(self.0.to_string()))
    }
}

/// The single management user.
///
/// Secret fields are skipped when serialized, so the type can be returned from
/// the API without leaking hashes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    /// Stable identifier.
    pub id: UserId,
    /// Informational login name.
    pub username: String,
    /// The account's primary address.
    pub primary_address: String,
    /// When the user was created.
    pub created_at: Timestamp,
    /// When the password last changed.
    pub password_changed_at: Option<Timestamp>,
    /// When first-run setup completed.
    pub setup_completed_at: Option<Timestamp>,
    /// Argon2id password hash.
    #[serde(skip)]
    pub password_hash: Option<String>,
    /// Single-use setup token hash.
    #[serde(skip)]
    pub setup_token_hash: Option<String>,
    /// Setup token expiry.
    #[serde(skip)]
    pub setup_token_expires_at: Option<Timestamp>,
}

impl User {
    /// Whether the account has a usable management password.
    pub fn has_password(&self) -> bool {
        self.password_hash.is_some()
    }

    /// Whether first-run setup is still pending.
    pub fn setup_pending(&self) -> bool {
        self.setup_completed_at.is_none()
    }
}

/// A server-side revocable session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// Stable session identifier.
    pub id: SessionId,
    /// Owning user.
    pub user_id: UserId,
    /// When the session was created.
    pub created_at: Timestamp,
    /// Most recent authenticated use.
    pub last_used_at: Timestamp,
    /// When the session expires.
    pub expires_at: Timestamp,
    /// When the session was revoked, if it has been.
    pub revoked_at: Option<Timestamp>,
    /// Token presented by the client in the session cookie.
    #[serde(skip)]
    pub token_hash: String,
    /// CSRF token the client must echo on cookie-authenticated mutations.
    pub csrf_token: String,
}

impl Session {
    /// Whether the session is revoked or expired at `now`.
    pub fn is_live(&self, now: Timestamp) -> bool {
        self.revoked_at.is_none() && self.expires_at > now
    }
}

/// A stored one-time recovery code.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCode {
    /// Stable identifier.
    pub id: RecoveryCodeId,
    /// Owning user.
    pub user_id: UserId,
    /// When the code was generated.
    pub created_at: Timestamp,
    /// When the code was consumed.
    pub used_at: Option<Timestamp>,
    /// Hash of the code.
    #[serde(skip)]
    pub code_hash: String,
}

/// A stored passkey credential.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasskeyRecord {
    /// Credential identifier, base64url encoded.
    pub id: String,
    /// Owning user.
    pub user_id: UserId,
    /// User-facing name.
    pub name: String,
    /// Serialized `webauthn-rs` credential.
    pub credential: String,
    /// When the passkey was registered.
    pub created_at: Timestamp,
    /// Most recent successful authentication.
    pub last_used_at: Option<Timestamp>,
}

/// The Dovecot mail credential, managed separately from management auth.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailCredential {
    /// Owning user.
    pub user_id: UserId,
    /// When the credential was first set.
    pub created_at: Timestamp,
    /// When the credential was last rotated.
    pub rotated_at: Option<Timestamp>,
    /// When the credential was revoked.
    pub revoked_at: Option<Timestamp>,
    /// Argon2id hash of the mail password.
    #[serde(skip)]
    pub password_hash: Option<String>,
}

impl MailCredential {
    /// Whether a usable mail password is currently set.
    pub fn is_configured(&self) -> bool {
        self.password_hash.is_some() && self.revoked_at.is_none()
    }
}

/// Authentication and identity failures.
#[derive(Debug, Error)]
pub enum AuthError {
    /// Storage failure.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// Password hashing or verification failed.
    #[error("password hashing failed: {0}")]
    Hash(String),
    /// The user does not exist.
    #[error("no management user is configured")]
    NoUser,
    /// A user already exists.
    #[error("a management user already exists")]
    AlreadyBootstrapped,
    /// The setup token is missing, expired, or already used.
    #[error("invalid or expired setup token")]
    InvalidSetupToken,
    /// Setup is already complete.
    #[error("setup is already complete")]
    SetupComplete,
    /// The password is too short.
    #[error("password must be at least {MIN_PASSWORD_LENGTH} characters")]
    WeakPassword,
    /// The password is wrong.
    #[error("invalid credentials")]
    InvalidCredentials,
    /// The session token is unknown, revoked, or expired.
    #[error("session is not valid")]
    InvalidSession,
    /// The recovery code is unknown or already used.
    #[error("invalid recovery code")]
    InvalidRecoveryCode,
    /// No mail credential is configured.
    #[error("no mail credential is configured")]
    NoMailCredential,
    /// Passkey operations failed.
    #[error("passkey error: {0}")]
    Passkey(String),
}

/// Generates a fresh random secret, base64url encoded without padding.
pub fn random_secret(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).expect("operating system randomness is available");
    URL_SAFE_NO_PAD.encode(buffer)
}

/// Hashes a secret for storage with SHA-256.
///
/// Tokens, session identifiers, setup tokens, and recovery codes are
/// high-entropy random values, so a fast keyed-independent hash is sufficient
/// for lookup and at-rest protection.
pub fn hash_secret(secret: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(secret.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

/// Compares two byte slices in constant time.
pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        difference |= a ^ b;
    }
    difference == 0
}

/// Hashes a management password with Argon2id.
pub fn hash_password(password: &str) -> Result<String, AuthError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| AuthError::Hash(error.to_string()))
}

/// Verifies a password against an Argon2id hash.
pub fn verify_password(hash: &str, password: &str) -> Result<bool, AuthError> {
    let parsed = PasswordHash::new(hash).map_err(|error| AuthError::Hash(error.to_string()))?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}

fn format_recovery_code(raw: &str) -> String {
    let upper = raw.to_ascii_uppercase();
    let half = upper.len() / 2;
    format!("{}-{}", &upper[..half], &upper[half..])
}

/// Generates a fresh recovery code and its stored hash.
pub fn generate_recovery_code() -> (String, String) {
    let code = format_recovery_code(&random_secret(6));
    let hash = hash_secret(&code);
    (code, hash)
}

/// Higher-level identity flows over a [`Store`] and a clock.
pub struct IdentityService<'a> {
    store: &'a Store,
    clock: SharedClock,
    session_ttl_seconds: i64,
    setup_token_ttl_seconds: i64,
}

impl<'a> IdentityService<'a> {
    /// Creates the service with the default session and setup-token lifetimes.
    pub fn new(store: &'a Store, clock: SharedClock) -> Self {
        Self {
            store,
            clock,
            session_ttl_seconds: SESSION_TTL_SECONDS,
            setup_token_ttl_seconds: SETUP_TOKEN_TTL_SECONDS,
        }
    }

    /// Overrides the session lifetime, for tests.
    pub fn with_session_ttl(mut self, seconds: i64) -> Self {
        self.session_ttl_seconds = seconds;
        self
    }

    /// Overrides the setup-token lifetime, for tests.
    pub fn with_setup_token_ttl(mut self, seconds: i64) -> Self {
        self.setup_token_ttl_seconds = seconds;
        self
    }

    fn now(&self) -> Timestamp {
        self.clock.now()
    }

    /// The configured user, if any.
    pub fn user(&self) -> Result<Option<User>, AuthError> {
        Ok(self.store.get_user()?)
    }

    /// The configured user, or [`AuthError::NoUser`].
    pub fn require_user(&self) -> Result<User, AuthError> {
        self.user()?.ok_or(AuthError::NoUser)
    }

    /// Creates the user and a single-use setup token.
    ///
    /// Returns the user and the plaintext setup token, which is shown once and
    /// stored only as a hash. Refuses to run when a user already exists, so
    /// there are no default credentials and bootstrap is not repeatable.
    pub fn bootstrap(
        &self,
        username: impl Into<String>,
        primary_address: impl Into<String>,
    ) -> Result<(User, String), AuthError> {
        if self.store.get_user()?.is_some() {
            return Err(AuthError::AlreadyBootstrapped);
        }
        let now = self.now();
        let setup_token = random_secret(32);
        let user = User {
            id: UserId::new(),
            username: username.into(),
            primary_address: primary_address.into(),
            created_at: now,
            password_changed_at: None,
            setup_completed_at: None,
            password_hash: None,
            setup_token_hash: Some(hash_secret(&setup_token)),
            setup_token_expires_at: now
                .checked_add(time::Duration::seconds(self.setup_token_ttl_seconds)),
        };
        self.store.insert_user(&user)?;
        Ok((user, setup_token))
    }

    /// Completes first-run setup by setting the management password.
    ///
    /// The setup token is single-use: it is cleared on success.
    pub fn complete_setup(&self, setup_token: &str, password: &str) -> Result<User, AuthError> {
        if password.chars().count() < MIN_PASSWORD_LENGTH {
            return Err(AuthError::WeakPassword);
        }
        let mut user = self.require_user()?;
        if !user.setup_pending() {
            return Err(AuthError::SetupComplete);
        }
        let Some(expected) = user.setup_token_hash.clone() else {
            return Err(AuthError::InvalidSetupToken);
        };
        let valid = constant_time_eq(hash_secret(setup_token).as_bytes(), expected.as_bytes());
        let unexpired = user
            .setup_token_expires_at
            .is_some_and(|expires| expires > self.now());
        if !valid || !unexpired {
            return Err(AuthError::InvalidSetupToken);
        }
        let now = self.now();
        user.password_hash = Some(hash_password(password)?);
        user.password_changed_at = Some(now);
        user.setup_completed_at = Some(now);
        user.setup_token_hash = None;
        user.setup_token_expires_at = None;
        self.store.update_user(&user)?;
        self.store.revoke_user_sessions(user.id, now)?;
        Ok(user)
    }

    /// Sets a new management password directly, for local CLI recovery.
    ///
    /// Local host access authorizes the reset; every existing session is
    /// revoked.
    pub fn reset_password(&self, password: &str) -> Result<User, AuthError> {
        if password.chars().count() < MIN_PASSWORD_LENGTH {
            return Err(AuthError::WeakPassword);
        }
        let mut user = self.require_user()?;
        let now = self.now();
        user.password_hash = Some(hash_password(password)?);
        user.password_changed_at = Some(now);
        user.setup_completed_at = Some(now);
        user.setup_token_hash = None;
        user.setup_token_expires_at = None;
        self.store.update_user(&user)?;
        self.store.revoke_user_sessions(user.id, now)?;
        Ok(user)
    }

    /// Rotates the management password, verifying the current one first.
    pub fn change_password(&self, current: &str, next: &str) -> Result<User, AuthError> {
        let user = self.require_user()?;
        let hash = user.password_hash.as_deref().ok_or(AuthError::NoUser)?;
        if !verify_password(hash, current)? {
            return Err(AuthError::InvalidCredentials);
        }
        self.reset_password(next)
    }

    /// Authenticates with the management password and starts a session.
    ///
    /// Returns the stored session and the plaintext session token for the
    /// cookie. The token is never persisted.
    pub fn login(&self, password: &str) -> Result<(Session, String), AuthError> {
        let user = self.require_user()?;
        let hash = user
            .password_hash
            .as_deref()
            .ok_or(AuthError::InvalidCredentials)?;
        if !verify_password(hash, password)? {
            return Err(AuthError::InvalidCredentials);
        }
        self.start_session(user.id)
    }

    /// Starts a session for a user that has already been authenticated.
    pub fn start_session(&self, user_id: UserId) -> Result<(Session, String), AuthError> {
        let now = self.now();
        let token = random_secret(32);
        let session = Session {
            id: SessionId::new(),
            user_id,
            created_at: now,
            last_used_at: now,
            expires_at: now
                .checked_add(time::Duration::seconds(self.session_ttl_seconds))
                .unwrap_or(now),
            revoked_at: None,
            token_hash: hash_secret(&token),
            csrf_token: random_secret(32),
        };
        self.store.insert_session(&session)?;
        Ok((session, token))
    }

    /// Resolves a session token from a cookie, refreshing its last-used time.
    pub fn authenticate_session(&self, token: &str) -> Result<Option<Session>, AuthError> {
        let Some(mut session) = self.store.get_session_by_hash(&hash_secret(token))? else {
            return Ok(None);
        };
        let now = self.now();
        if !session.is_live(now) {
            return Ok(None);
        }
        session.last_used_at = now;
        self.store.update_session(&session)?;
        Ok(Some(session))
    }

    /// Revokes a session. Revoking an unknown session is a no-op.
    pub fn logout(&self, session_id: SessionId) -> Result<(), AuthError> {
        self.store
            .revoke_session(session_id, self.now())
            .map(|_| ())
            .map_err(AuthError::from)
    }

    /// Revokes every session for the user.
    pub fn revoke_all_sessions(&self, user_id: UserId) -> Result<usize, AuthError> {
        Ok(self.store.revoke_user_sessions(user_id, self.now())?)
    }

    /// Lists live sessions for the user.
    pub fn sessions(&self, user_id: UserId) -> Result<Vec<Session>, AuthError> {
        let now = self.now();
        Ok(self
            .store
            .list_user_sessions(user_id)?
            .into_iter()
            .filter(|session| session.is_live(now))
            .collect())
    }

    /// Generates a fresh set of one-time recovery codes, replacing unused ones.
    ///
    /// Returns the plaintext codes, shown once.
    pub fn rotate_recovery_codes(&self) -> Result<Vec<String>, AuthError> {
        let user = self.require_user()?;
        self.store.delete_recovery_codes(user.id)?;
        let now = self.now();
        let mut plaintext = Vec::with_capacity(RECOVERY_CODE_COUNT);
        for _ in 0..RECOVERY_CODE_COUNT {
            let (code, code_hash) = generate_recovery_code();
            let record = RecoveryCode {
                id: RecoveryCodeId::new(),
                user_id: user.id,
                created_at: now,
                used_at: None,
                code_hash,
            };
            self.store.insert_recovery_code(&record)?;
            plaintext.push(code);
        }
        Ok(plaintext)
    }

    /// Remaining unused recovery codes.
    pub fn recovery_code_count(&self, user_id: UserId) -> Result<usize, AuthError> {
        Ok(self
            .store
            .list_recovery_codes(user_id)?
            .into_iter()
            .filter(|code| code.used_at.is_none())
            .count())
    }

    /// Recovers the account with a one-time code and sets a new password.
    pub fn recover(&self, code: &str, password: &str) -> Result<User, AuthError> {
        if password.chars().count() < MIN_PASSWORD_LENGTH {
            return Err(AuthError::WeakPassword);
        }
        let mut user = self.require_user()?;
        let code_hash = hash_secret(&code.to_ascii_uppercase());
        let mut matched = None;
        for candidate in self.store.list_recovery_codes(user.id)? {
            if candidate.used_at.is_none()
                && constant_time_eq(candidate.code_hash.as_bytes(), code_hash.as_bytes())
            {
                matched = Some(candidate);
                break;
            }
        }
        let Some(mut matched) = matched else {
            return Err(AuthError::InvalidRecoveryCode);
        };
        let now = self.now();
        user.password_hash = Some(hash_password(password)?);
        user.password_changed_at = Some(now);
        user.setup_completed_at = Some(now);
        user.setup_token_hash = None;
        user.setup_token_expires_at = None;
        self.store.update_user(&user)?;
        matched.used_at = Some(now);
        self.store.update_recovery_code(&matched)?;
        self.store.revoke_user_sessions(user.id, now)?;
        Ok(user)
    }

    /// The mail credential record, if one exists.
    pub fn mail_credential(&self) -> Result<Option<MailCredential>, AuthError> {
        Ok(self.store.get_mail_credential()?)
    }

    /// Sets or rotates the mail credential, returning the plaintext password.
    pub fn rotate_mail_credential(&self, password: &str) -> Result<MailCredential, AuthError> {
        let user = self.require_user()?;
        if password.is_empty() {
            return Err(AuthError::WeakPassword);
        }
        let now = self.now();
        let existing = self.store.get_mail_credential()?;
        let credential = MailCredential {
            user_id: user.id,
            created_at: existing.as_ref().map_or(now, |value| value.created_at),
            rotated_at: Some(now),
            revoked_at: None,
            password_hash: Some(hash_password(password)?),
        };
        self.store.upsert_mail_credential(&credential)?;
        Ok(credential)
    }

    /// Revokes the mail credential. A revoked credential no longer verifies.
    pub fn revoke_mail_credential(&self) -> Result<MailCredential, AuthError> {
        let mut credential = self
            .store
            .get_mail_credential()?
            .ok_or(AuthError::NoMailCredential)?;
        credential.revoked_at = Some(self.now());
        credential.password_hash = None;
        self.store.upsert_mail_credential(&credential)?;
        Ok(credential)
    }

    /// Verifies a mail password against the stored credential.
    pub fn verify_mail_password(&self, password: &str) -> Result<bool, AuthError> {
        let Some(credential) = self.store.get_mail_credential()? else {
            return Ok(false);
        };
        if !credential.is_configured() {
            return Ok(false);
        }
        let Some(hash) = credential.password_hash.as_deref() else {
            return Ok(false);
        };
        verify_password(hash, password)
    }
}

#[cfg(test)]
mod tests {
    use super::{AuthError, IdentityService, MIN_PASSWORD_LENGTH, hash_password, verify_password};
    use crate::clock::FixedClock;
    use crate::db::Store;
    use crate::timestamp::Timestamp;
    use std::sync::Arc;

    fn at(value: &str) -> Timestamp {
        value.parse().unwrap()
    }

    fn store() -> Store {
        let mut store = Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        store
    }

    fn service<'a>(store: &'a Store) -> IdentityService<'a> {
        IdentityService::new(store, Arc::new(FixedClock::new(at("2026-01-01T00:00:00Z"))))
    }

    const PASSWORD: &str = "correct horse battery";

    #[test]
    fn password_hashes_are_argon2id_and_verify() {
        let hash = hash_password(PASSWORD).unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password(&hash, PASSWORD).unwrap());
        assert!(!verify_password(&hash, "wrong password here").unwrap());
    }

    #[test]
    fn bootstrap_creates_one_user_and_a_single_use_token() {
        let store = store();
        let service = service(&store);
        let (user, token) = service.bootstrap("owner", "user@example.com").unwrap();
        assert!(user.setup_pending());
        assert!(!user.has_password());
        assert!(!token.is_empty());

        // Bootstrap is not repeatable: there are no default credentials.
        assert!(matches!(
            service.bootstrap("owner", "user@example.com"),
            Err(AuthError::AlreadyBootstrapped)
        ));

        // The token is stored only as a hash.
        let stored = service.require_user().unwrap();
        assert_ne!(stored.setup_token_hash.as_deref(), Some(token.as_str()));
    }

    #[test]
    fn setup_consumes_the_token_and_sets_the_password() {
        let store = store();
        let service = service(&store);
        let (_user, token) = service.bootstrap("owner", "user@example.com").unwrap();
        let user = service.complete_setup(&token, PASSWORD).unwrap();
        assert!(user.has_password());
        assert!(!user.setup_pending());

        // The single-use token no longer works.
        assert!(matches!(
            service.complete_setup(&token, PASSWORD),
            Err(AuthError::SetupComplete)
        ));
        assert!(service.login(PASSWORD).is_ok());
        assert!(matches!(
            service.login("not the password"),
            Err(AuthError::InvalidCredentials)
        ));
    }

    #[test]
    fn setup_rejects_short_passwords_and_expired_tokens() {
        let store = store();
        let service = IdentityService::new(
            &store,
            Arc::new(FixedClock::new(at("2026-01-01T00:00:00Z"))),
        )
        .with_setup_token_ttl(60);
        let (_user, token) = service.bootstrap("owner", "user@example.com").unwrap();
        assert!(matches!(
            service.complete_setup(&token, "short"),
            Err(AuthError::WeakPassword)
        ));
        assert!(MIN_PASSWORD_LENGTH > "short".len());

        let late = IdentityService::new(
            &store,
            Arc::new(FixedClock::new(at("2026-01-02T00:00:00Z"))),
        );
        assert!(matches!(
            late.complete_setup(&token, PASSWORD),
            Err(AuthError::InvalidSetupToken)
        ));
    }

    #[test]
    fn sessions_are_server_side_and_revocable() {
        let store = store();
        let service = service(&store);
        let (_user, token) = service.bootstrap("owner", "user@example.com").unwrap();
        service.complete_setup(&token, PASSWORD).unwrap();

        let (session, session_token) = service.login(PASSWORD).unwrap();
        assert!(
            service
                .authenticate_session(&session_token)
                .unwrap()
                .is_some()
        );

        service.logout(session.id).unwrap();
        assert!(
            service
                .authenticate_session(&session_token)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn reset_password_revokes_existing_sessions() {
        let store = store();
        let service = service(&store);
        let (_user, token) = service.bootstrap("owner", "user@example.com").unwrap();
        service.complete_setup(&token, PASSWORD).unwrap();
        let (_session, session_token) = service.login(PASSWORD).unwrap();

        service.reset_password("a brand new secret").unwrap();
        assert!(
            service
                .authenticate_session(&session_token)
                .unwrap()
                .is_none()
        );
        assert!(service.login(PASSWORD).is_err());
        assert!(service.login("a brand new secret").is_ok());
    }

    #[test]
    fn recovery_codes_are_one_time() {
        let store = store();
        let service = service(&store);
        let (_user, token) = service.bootstrap("owner", "user@example.com").unwrap();
        service.complete_setup(&token, PASSWORD).unwrap();
        let codes = service.rotate_recovery_codes().unwrap();
        assert_eq!(codes.len(), super::RECOVERY_CODE_COUNT);

        service.recover(&codes[0], "recovered password").unwrap();
        assert!(service.login("recovered password").is_ok());
        assert!(matches!(
            service.recover(&codes[0], "another password"),
            Err(AuthError::InvalidRecoveryCode)
        ));
    }

    #[test]
    fn the_mail_credential_is_separate_and_revocable() {
        let store = store();
        let service = service(&store);
        let (_user, token) = service.bootstrap("owner", "user@example.com").unwrap();
        service.complete_setup(&token, PASSWORD).unwrap();

        let credential = service.rotate_mail_credential("mail-secret").unwrap();
        assert!(credential.is_configured());
        assert!(service.verify_mail_password("mail-secret").unwrap());
        // The mail password is not the management password.
        assert!(service.login("mail-secret").is_err());

        service.revoke_mail_credential().unwrap();
        assert!(!service.verify_mail_password("mail-secret").unwrap());
    }
}
