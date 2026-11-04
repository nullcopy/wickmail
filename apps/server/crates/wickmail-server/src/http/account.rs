//! Bootstrap, session, recovery, and mail-credential endpoints.

use axum::Json;
use axum::extract::State;
use axum::http::header;
use axum::http::{HeaderMap, HeaderValue, StatusCode};

use crate::abuse::AlertKind;
use crate::api::{
    LoginRequest, MailCredentialResponse, RecoverRequest, RotateMailCredentialRequest,
    RotateMailCredentialResponse, SessionInfo, SessionResponse, SetupRequest, SetupResponse,
    UserResponse,
};
use crate::identity::random_secret;

use super::auth::Auth;
use super::{ApiError, AppState};

/// Completes first-run setup with the single-use setup token.
pub async fn setup(
    State(state): State<AppState>,
    Json(body): Json<SetupRequest>,
) -> Result<Json<SetupResponse>, ApiError> {
    limit_auth(&state)?;
    let service = state.lock_service();
    let identity = state.identity(&service);
    let user = match identity.complete_setup(&body.setup_token, &body.password) {
        Ok(user) => user,
        Err(error) => {
            alert_auth_failure(&state, "first-run setup failed");
            return Err(error.into());
        }
    };
    Ok(Json(SetupResponse {
        user: UserResponse::from(user),
    }))
}

/// Starts a browser session with the management password.
pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> Result<(HeaderMap, Json<SessionResponse>), ApiError> {
    limit_auth(&state)?;
    let service = state.lock_service();
    let identity = state.identity(&service);
    let (session, token) = match identity.login(&body.password) {
        Ok(value) => value,
        Err(error) => {
            alert_auth_failure(&state, "management login failed");
            return Err(error.into());
        }
    };
    let csrf_token = session.csrf_token.clone();
    let response = SessionResponse {
        session: SessionInfo::from(session),
        csrf_token,
    };
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&state.config.session_cookie_header(&token))
            .map_err(|_| ApiError::internal("invalid session cookie"))?,
    );
    Ok((headers, Json(response)))
}

/// Returns the current session and CSRF token.
pub async fn current_session(
    State(state): State<AppState>,
    auth: Auth,
) -> Result<Json<SessionResponse>, ApiError> {
    let principal = auth.require_session()?;
    let service = state.lock_service();
    let session = service
        .store()
        .get_session(principal.session_id)?
        .ok_or_else(|| ApiError::unauthorized("session is not valid"))?;
    Ok(Json(SessionResponse {
        session: SessionInfo::from(session.clone()),
        csrf_token: session.csrf_token,
    }))
}

/// Ends the current session.
pub async fn logout(
    State(state): State<AppState>,
    auth: Auth,
) -> Result<(HeaderMap, StatusCode), ApiError> {
    let principal = auth.require_session()?;
    {
        let service = state.lock_service();
        let identity = state.identity(&service);
        identity.logout(principal.session_id)?;
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&state.config.clear_session_cookie_header())
            .map_err(|_| ApiError::internal("invalid session cookie"))?,
    );
    Ok((headers, StatusCode::NO_CONTENT))
}

/// Recovers the account with a one-time recovery code and a new password.
pub async fn recover(
    State(state): State<AppState>,
    Json(body): Json<RecoverRequest>,
) -> Result<Json<SetupResponse>, ApiError> {
    limit_auth(&state)?;
    let service = state.lock_service();
    let identity = state.identity(&service);
    let user = match identity.recover(&body.code, &body.password) {
        Ok(user) => user,
        Err(error) => {
            alert_auth_failure(&state, "account recovery failed");
            return Err(error.into());
        }
    };
    Ok(Json(SetupResponse {
        user: UserResponse::from(user),
    }))
}

/// Reports the mail credential status. Requires a browser session.
pub async fn get_mail_credential(
    State(state): State<AppState>,
    auth: Auth,
) -> Result<Json<MailCredentialResponse>, ApiError> {
    auth.require_session()?;
    let service = state.lock_service();
    let identity = state.identity(&service);
    let credential = identity.mail_credential()?.ok_or_else(|| {
        ApiError::not_found("no_mail_credential", "no mail credential is configured")
    })?;
    Ok(Json(MailCredentialResponse::from(credential)))
}

/// Sets or rotates the mail credential. The password is shown once.
pub async fn rotate_mail_credential(
    State(state): State<AppState>,
    auth: Auth,
    body: Option<Json<RotateMailCredentialRequest>>,
) -> Result<Json<RotateMailCredentialResponse>, ApiError> {
    auth.require_session()?;
    let password = body
        .and_then(|Json(body)| body.password)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| random_secret(18));
    let service = state.lock_service();
    let identity = state.identity(&service);
    let credential = identity.rotate_mail_credential(&password)?;
    Ok(Json(RotateMailCredentialResponse {
        credential: MailCredentialResponse::from(credential),
        password,
    }))
}

/// Revokes the mail credential. Requires a browser session.
pub async fn revoke_mail_credential(
    State(state): State<AppState>,
    auth: Auth,
) -> Result<Json<MailCredentialResponse>, ApiError> {
    auth.require_session()?;
    let service = state.lock_service();
    let identity = state.identity(&service);
    let credential = identity.revoke_mail_credential()?;
    Ok(Json(MailCredentialResponse::from(credential)))
}

fn limit_auth(state: &AppState) -> Result<(), ApiError> {
    state
        .auth_limiter
        .check_global(state.config.login_rate, state.now())
        .map_err(|limited| {
            alert_auth_failure(state, "management authentication rate limit reached");
            ApiError::too_many_requests(limited.retry_after_seconds)
        })
}

/// Records a failed authentication attempt so an operator alert can fire.
fn alert_auth_failure(state: &AppState, message: &str) {
    state
        .alerter
        .alert(AlertKind::AuthenticationFailure, message);
}
