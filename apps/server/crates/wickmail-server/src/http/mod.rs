//! The `/v1` HTTP management API.
//!
//! The API is JSON over HTTPS and is served by the same process as the mail
//! path. Browser sessions use `Secure`, `HttpOnly`, and `SameSite` cookies;
//! cookie-authenticated mutations require a CSRF token; programmatic clients
//! use scoped bearer tokens. Every endpoint enforces its required scope, and
//! mutating endpoints support idempotent retry through an `Idempotency-Key`
//! header. Built web assets are served from the same origin.

mod account;
mod aliases;
mod auth;
mod messages;
#[cfg(feature = "passkeys")]
mod passkeys;
mod quarantine;
mod static_files;
mod tokens;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use thiserror::Error;

use crate::abuse::{Alerter, LogAlerter, RateLimit, RateLimiter};
use crate::address::{CanonicalAddress, Domain};
use crate::api::{API_CONTRACT_VERSION, ErrorResponse};
use crate::clock::SharedClock;
use crate::db::StoreError;
use crate::identity::{AuthError, IdentityService};
use crate::mail::store::MailStoreAdapter;
use crate::reply::DkimSigner;
use crate::reply::queue::OutboundQueue;
use crate::service::AliasService;
use crate::timestamp::Timestamp;
use crate::token::TokenError;

pub use auth::{Auth, Principal, SessionPrincipal, TokenPrincipal};

#[cfg(feature = "passkeys")]
pub use passkeys::build_webauthn;

/// Default session cookie name.
pub const DEFAULT_SESSION_COOKIE: &str = "wickmail_session";

/// Default page size for list endpoints.
pub const DEFAULT_PAGE_SIZE: usize = 50;

/// Maximum page size for list endpoints.
pub const MAX_PAGE_SIZE: usize = 200;

/// How long idempotent responses are retained.
pub const IDEMPOTENCY_TTL_SECONDS: i64 = 24 * 60 * 60;

/// Default management authentication rate limit: 60 attempts per minute.
pub const DEFAULT_LOGIN_LIMIT: u32 = 60;

/// How a session cookie is scoped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SameSite {
    /// Sent on same-site requests and top-level navigations.
    Lax,
    /// Sent only on same-site requests.
    Strict,
    /// Sent on all requests; requires `Secure`.
    None,
}

impl SameSite {
    /// The cookie attribute value.
    pub fn as_str(self) -> &'static str {
        match self {
            SameSite::Lax => "Lax",
            SameSite::Strict => "Strict",
            SameSite::None => "None",
        }
    }
}

/// HTTP management API configuration.
#[derive(Clone, Debug)]
pub struct HttpConfig {
    /// The alias domain.
    pub domain: Domain,
    /// The account's primary address.
    pub primary: Option<CanonicalAddress>,
    /// Directory holding the built web assets, if any.
    pub web_root: Option<PathBuf>,
    /// Session cookie name.
    pub session_cookie: String,
    /// Whether the session cookie carries `Secure`.
    pub cookie_secure: bool,
    /// Session cookie `SameSite` policy.
    pub cookie_same_site: SameSite,
    /// Management session lifetime in seconds.
    pub session_ttl_seconds: i64,
    /// Idempotent response lifetime in seconds.
    pub idempotency_ttl_seconds: i64,
    /// Management authentication rate limit.
    pub login_rate: RateLimit,
    /// WebAuthn relying-party identifier.
    pub rp_id: String,
    /// WebAuthn allowed origin.
    pub rp_origin: String,
}

impl HttpConfig {
    /// Builds a configuration for a domain and primary address.
    pub fn new(domain: Domain, primary: Option<CanonicalAddress>) -> Self {
        let rp_id = domain.to_string();
        let rp_origin = format!("https://{rp_id}");
        Self {
            domain,
            primary,
            web_root: None,
            session_cookie: DEFAULT_SESSION_COOKIE.to_string(),
            cookie_secure: true,
            cookie_same_site: SameSite::Lax,
            session_ttl_seconds: crate::identity::SESSION_TTL_SECONDS,
            idempotency_ttl_seconds: IDEMPOTENCY_TTL_SECONDS,
            login_rate: RateLimit::per_hour(DEFAULT_LOGIN_LIMIT * 60),
            rp_id,
            rp_origin,
        }
    }

    /// The `Set-Cookie` header that starts a session.
    pub fn session_cookie_header(&self, token: &str) -> String {
        self.cookie(&format!("{token}; Max-Age={}", self.session_ttl_seconds))
    }

    /// The `Set-Cookie` header that clears a session.
    pub fn clear_session_cookie_header(&self) -> String {
        self.cookie("; Max-Age=0")
    }

    fn cookie(&self, value: &str) -> String {
        let mut cookie = format!(
            "{}={value}; Path=/; HttpOnly; SameSite={}",
            self.session_cookie,
            self.cookie_same_site.as_str()
        );
        if self.cookie_secure {
            cookie.push_str("; Secure");
        }
        cookie
    }
}

/// Shared state for every management API handler.
#[derive(Clone)]
pub struct AppState {
    /// Alias service, shared with the mail path.
    pub service: Arc<Mutex<AliasService>>,
    /// Internal mail-store adapter.
    pub mail: Arc<MailStoreAdapter>,
    /// Outbound reply queue.
    pub queue: Arc<dyn OutboundQueue>,
    /// Optional DKIM signer for outbound replies.
    pub dkim: Option<Arc<DkimSigner>>,
    /// The account's primary address.
    pub primary: Option<CanonicalAddress>,
    /// Static configuration.
    pub config: Arc<HttpConfig>,
    /// Clock used for evaluation and timestamps.
    pub clock: SharedClock,
    /// Rate limiter for management authentication.
    pub auth_limiter: Arc<RateLimiter>,
    /// Alert sink.
    pub alerter: Arc<dyn Alerter>,
    /// Optional WebAuthn instance, present when passkeys are configured.
    #[cfg(feature = "passkeys")]
    pub webauthn: Option<Arc<webauthn_rs::Webauthn>>,
    /// In-flight WebAuthn flows, keyed by state identifier.
    #[cfg(feature = "passkeys")]
    pub passkey_state: Arc<Mutex<HashMap<String, passkeys::PasskeyFlow>>>,
}

impl AppState {
    /// Builds state from the mail path's shared components.
    pub fn new(
        service: Arc<Mutex<AliasService>>,
        mail: Arc<MailStoreAdapter>,
        queue: Arc<dyn OutboundQueue>,
        config: HttpConfig,
        clock: SharedClock,
    ) -> Self {
        let primary = config.primary.clone();
        Self {
            service,
            mail,
            queue,
            dkim: None,
            primary,
            config: Arc::new(config),
            clock,
            auth_limiter: Arc::new(RateLimiter::new()),
            alerter: Arc::new(LogAlerter),
            #[cfg(feature = "passkeys")]
            webauthn: None,
            #[cfg(feature = "passkeys")]
            passkey_state: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Sets the DKIM signer used for outbound replies.
    pub fn with_dkim(mut self, dkim: Arc<DkimSigner>) -> Self {
        self.dkim = Some(dkim);
        self
    }

    /// Enables WebAuthn passkey registration and authentication.
    #[cfg(feature = "passkeys")]
    pub fn with_webauthn(mut self, webauthn: Arc<webauthn_rs::Webauthn>) -> Self {
        self.webauthn = Some(webauthn);
        self
    }

    /// Sets the alert sink.
    pub fn with_alerter(mut self, alerter: Arc<dyn Alerter>) -> Self {
        self.alerter = alerter;
        self
    }

    /// Locks the shared alias service, recovering from a poisoned lock.
    pub fn lock_service(&self) -> MutexGuard<'_, AliasService> {
        self.service
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    /// The current time.
    pub fn now(&self) -> Timestamp {
        self.clock.now()
    }

    /// Builds an identity service over the shared store.
    pub fn identity<'a>(&self, service: &'a AliasService) -> IdentityService<'a> {
        IdentityService::new(service.store(), self.clock.clone())
    }
}

/// A management API failure that maps to an error envelope and status code.
#[derive(Debug, Error)]
#[error("{code}: {message}")]
pub struct ApiError {
    /// HTTP status.
    pub status: StatusCode,
    /// Stable machine-readable error code.
    pub code: String,
    /// Human-readable message.
    pub message: String,
}

impl ApiError {
    /// Builds an error.
    pub fn new(status: StatusCode, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }

    /// `400 Bad Request`.
    pub fn bad_request(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    /// `401 Unauthorized`.
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }

    /// `403 Forbidden` for a missing scope.
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message)
    }

    /// `403 Forbidden` for a CSRF failure.
    pub fn csrf() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "csrf_failed",
            "missing or invalid CSRF token",
        )
    }

    /// `404 Not Found`.
    pub fn not_found(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message)
    }

    /// `409 Conflict`.
    pub fn conflict(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }

    /// `429 Too Many Requests`.
    pub fn too_many_requests(retry_after_seconds: i64) -> Self {
        Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            format!("too many attempts; retry in {retry_after_seconds}s"),
        )
    }

    /// `503 Service Unavailable`.
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", message)
    }

    /// `500 Internal Server Error`.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = ErrorResponse {
            code: self.code,
            message: self.message,
        };
        (self.status, axum::Json(body)).into_response()
    }
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::NotFound(_) | StoreError::MissingUser(_) => {
                ApiError::not_found("not_found", error.to_string())
            }
            StoreError::VersionConflict(_) => {
                ApiError::conflict("version_conflict", error.to_string())
            }
            other => ApiError::internal(other.to_string()),
        }
    }
}

impl From<AuthError> for ApiError {
    fn from(error: AuthError) -> Self {
        match error {
            AuthError::NoUser | AuthError::InvalidCredentials | AuthError::InvalidSession => {
                ApiError::unauthorized(error.to_string())
            }
            AuthError::AlreadyBootstrapped
            | AuthError::SetupComplete
            | AuthError::InvalidSetupToken
            | AuthError::InvalidRecoveryCode => {
                ApiError::conflict("auth_conflict", error.to_string())
            }
            AuthError::WeakPassword => ApiError::bad_request("weak_password", error.to_string()),
            AuthError::NoMailCredential => {
                ApiError::not_found("no_mail_credential", error.to_string())
            }
            AuthError::Passkey(_) => ApiError::bad_request("passkey", error.to_string()),
            other => ApiError::internal(other.to_string()),
        }
    }
}

impl From<TokenError> for ApiError {
    fn from(error: TokenError) -> Self {
        ApiError::bad_request("invalid_token", error.to_string())
    }
}

impl From<crate::service::ServiceError> for ApiError {
    fn from(error: crate::service::ServiceError) -> Self {
        use crate::service::ServiceError;
        match error {
            ServiceError::NotFound(_) => ApiError::not_found("alias_not_found", error.to_string()),
            ServiceError::InvalidExpiry(_) => {
                ApiError::bad_request("invalid_expiry", error.to_string())
            }
            ServiceError::Lease(_) => ApiError::bad_request("lease_error", error.to_string()),
            other => ApiError::internal(other.to_string()),
        }
    }
}

impl From<crate::quarantine::QuarantineError> for ApiError {
    fn from(error: crate::quarantine::QuarantineError) -> Self {
        use crate::quarantine::QuarantineError;
        match error {
            QuarantineError::NotFound(_) => {
                ApiError::not_found("quarantine_not_found", error.to_string())
            }
            QuarantineError::RecoveryBlocked(_) => {
                ApiError::conflict("recovery_blocked", error.to_string())
            }
            other => ApiError::internal(other.to_string()),
        }
    }
}

impl From<crate::reply::ReplyError> for ApiError {
    fn from(error: crate::reply::ReplyError) -> Self {
        use crate::reply::ReplyError;
        match error {
            ReplyError::MessageNotFound(_) => {
                ApiError::not_found("message_not_found", error.to_string())
            }
            ReplyError::AliasNotFound(_) => {
                ApiError::not_found("alias_not_found", error.to_string())
            }
            ReplyError::IdentityRequired => {
                ApiError::conflict("identity_required", error.to_string())
            }
            ReplyError::IdentityNotAllowed => {
                ApiError::forbidden("selected alias did not receive this message")
            }
            ReplyError::Rejected(_) | ReplyError::IdentityRejected(_) => {
                ApiError::bad_request("reply_rejected", error.to_string())
            }
            ReplyError::NoSender => ApiError::bad_request("no_sender", error.to_string()),
            other => ApiError::internal(other.to_string()),
        }
    }
}

/// HTTP server failures.
#[derive(Debug, Error)]
pub enum HttpError {
    /// The listening socket could not be bound or served.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// The async runtime could not start.
    #[error("http runtime: {0}")]
    Runtime(String),
}

/// Builds the management API router.
pub fn router(state: AppState) -> Router {
    let mut api = Router::new()
        .route("/setup", axum::routing::post(account::setup))
        .route("/sessions", axum::routing::post(account::login))
        .route(
            "/session",
            axum::routing::get(account::current_session).delete(account::logout),
        )
        .route("/recovery", axum::routing::post(account::recover))
        .route(
            "/mail-credential",
            axum::routing::get(account::get_mail_credential)
                .post(account::rotate_mail_credential)
                .delete(account::revoke_mail_credential),
        )
        .route(
            "/tokens",
            axum::routing::get(tokens::list).post(tokens::create),
        )
        .route("/tokens/{id}", axum::routing::delete(tokens::revoke))
        .route(
            "/aliases",
            axum::routing::get(aliases::list).post(aliases::create),
        )
        .route(
            "/aliases/{id}",
            axum::routing::get(aliases::get).patch(aliases::update),
        )
        .route("/aliases/{id}/renew", axum::routing::post(aliases::renew))
        .route("/aliases/{id}/extend", axum::routing::post(aliases::extend))
        .route(
            "/aliases/{id}/expiry",
            axum::routing::post(aliases::set_expiry).delete(aliases::remove_expiry),
        )
        .route(
            "/aliases/{id}/disable",
            axum::routing::post(aliases::disable),
        )
        .route("/aliases/{id}/enable", axum::routing::post(aliases::enable))
        .route("/aliases/{id}/events", axum::routing::get(aliases::events))
        .route("/quarantine", axum::routing::get(quarantine::list))
        .route("/quarantine/{id}", axum::routing::get(quarantine::get))
        .route(
            "/quarantine/{id}/recover",
            axum::routing::post(quarantine::recover),
        )
        .route(
            "/quarantine/{id}/delete",
            axum::routing::post(quarantine::delete),
        )
        .route("/messages", axum::routing::get(messages::list))
        .route(
            "/messages/{id}/reply-context",
            axum::routing::get(messages::reply_context),
        )
        .route("/messages/{id}/reply", axum::routing::post(messages::reply))
        .route("/version", axum::routing::get(version));

    #[cfg(feature = "passkeys")]
    {
        api = api
            .route("/passkeys", axum::routing::get(passkeys::list))
            .route(
                "/passkeys/registration/begin",
                axum::routing::post(passkeys::registration_begin),
            )
            .route(
                "/passkeys/registration/finish",
                axum::routing::post(passkeys::registration_finish),
            )
            .route(
                "/passkeys/authentication/begin",
                axum::routing::post(passkeys::authentication_begin),
            )
            .route(
                "/passkeys/authentication/finish",
                axum::routing::post(passkeys::authentication_finish),
            )
            .route("/passkeys/{id}", axum::routing::delete(passkeys::delete));
    }

    Router::new()
        .nest("/v1", api)
        .fallback(static_files::serve)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            idempotency_middleware,
        ))
        .with_state(state)
}

/// Reports the contract version.
async fn version() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({
        "product": crate::PRODUCT_NAME,
        "version": crate::version(),
        "apiContractVersion": API_CONTRACT_VERSION,
    }))
}

/// Binds `listen` and serves the management API until the process stops.
pub fn serve_http(state: AppState, listen: SocketAddr) -> Result<(), HttpError> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| HttpError::Runtime(error.to_string()))?;
    runtime.block_on(async move {
        let listener = tokio::net::TcpListener::bind(listen).await?;
        axum::serve(listener, router(state)).await?;
        Ok(())
    })
}

/// The request methods that mutate state.
fn is_mutating(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

/// Reads a cookie value from the request headers.
pub(crate) fn cookie_value(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    let header = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in header.split(';') {
        let part = part.trim();
        if let Some((key, value)) = part.split_once('=')
            && key == name
        {
            return Some(value.to_string());
        }
    }
    None
}

/// Encodes an opaque pagination cursor.
pub(crate) fn encode_cursor(value: &serde_json::Value) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap_or_default())
}

/// Decodes an opaque pagination cursor.
pub(crate) fn decode_cursor(cursor: &str) -> Option<serde_json::Value> {
    let bytes = URL_SAFE_NO_PAD.decode(cursor).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Clamps a requested page size.
pub(crate) fn page_size(requested: Option<usize>) -> usize {
    requested
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE)
}

/// Idempotency middleware: replays a stored response for a repeated key.
async fn idempotency_middleware(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if !is_mutating(request.method()) {
        return next.run(request).await;
    }
    let Some(key) = request
        .headers()
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
    else {
        return next.run(request).await;
    };

    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let (parts, body) = request.into_parts();
    let bytes = match axum::body::to_bytes(body, 16 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return ApiError::bad_request("body_too_large", "request body is too large")
                .into_response();
        }
    };
    let request_hash = crate::identity::hash_secret(&URL_SAFE_NO_PAD.encode(&bytes));

    {
        let service = state.lock_service();
        match service.store().get_idempotency(&key) {
            Ok(Some(stored)) => {
                if stored.method == method
                    && stored.path == path
                    && stored.request_hash == request_hash
                {
                    return replay_response(&stored.response_status, &stored.response_body);
                }
                return ApiError::conflict(
                    "idempotency_conflict",
                    "idempotency key was used with a different request",
                )
                .into_response();
            }
            Ok(None) => {}
            Err(error) => return ApiError::from(error).into_response(),
        }
    }

    let request = Request::from_parts(parts, Body::from(bytes));
    let response = next.run(request).await;
    if !response.status().is_success() {
        return response;
    }

    let (parts, body) = response.into_parts();
    let bytes = match axum::body::to_bytes(body, 16 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return Response::from_parts(parts, Body::empty()),
    };
    let body_text = String::from_utf8_lossy(&bytes).to_string();
    let record = crate::db::IdempotencyRecord {
        key,
        method,
        path,
        request_hash,
        response_status: i64::from(parts.status.as_u16()),
        response_body: body_text,
        created_at: state.now(),
    };
    {
        let service = state.lock_service();
        if let Err(error) = service.store().insert_idempotency(&record) {
            state
                .alerter
                .alert(crate::abuse::AlertKind::SpoolFailure, &error.to_string());
        }
    }
    Response::from_parts(parts, Body::from(bytes))
}

fn replay_response(status: &i64, body: &str) -> Response {
    let status = StatusCode::from_u16(*status as u16).unwrap_or(StatusCode::OK);
    let mut response = (status, body.to_string()).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}
