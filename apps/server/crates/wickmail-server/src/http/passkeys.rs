//! WebAuthn passkey registration and authentication.
//!
//! Passkeys are optional: when no WebAuthn instance is configured the
//! endpoints return `503`. Registration and authentication use the two-phase
//! WebAuthn ceremony; the server keeps the paired state in memory, keyed by a
//! random state identifier, so a challenge cannot be replayed.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};

use crate::api::{
    PasskeyChallengeResponse, PasskeyFinishRequest, PasskeyListResponse, PasskeyResponse,
    SessionInfo, SessionResponse,
};
use crate::identity::{PasskeyRecord, UserId, random_secret};

use super::auth::Auth;
use super::{ApiError, AppState, HttpConfig};

use webauthn_rs::prelude::{
    Passkey, PasskeyAuthentication, PasskeyRegistration, PublicKeyCredential,
    RegisterPublicKeyCredential, Webauthn, WebauthnBuilder,
};

/// A WebAuthn ceremony in progress.
pub enum PasskeyFlow {
    /// Registration of a new passkey.
    Registration {
        /// The user registering.
        user_id: UserId,
        /// Paired registration state.
        registration: PasskeyRegistration,
    },
    /// Authentication with an existing passkey.
    Authentication {
        /// The user authenticating.
        user_id: UserId,
        /// Paired authentication state.
        authentication: PasskeyAuthentication,
    },
}

/// Builds a WebAuthn instance for the configured relying party.
pub fn build_webauthn(config: &HttpConfig) -> Result<Webauthn, ApiError> {
    let origin = url::Url::parse(&config.rp_origin)
        .map_err(|error| ApiError::internal(format!("invalid rp origin: {error}")))?;
    WebauthnBuilder::new(&config.rp_id, &origin)
        .and_then(WebauthnBuilder::build)
        .map_err(|error| ApiError::internal(format!("invalid webauthn configuration: {error}")))
}

/// Lists registered passkeys. Requires a browser session.
pub async fn list(
    State(state): State<AppState>,
    auth: Auth,
) -> Result<Json<PasskeyListResponse>, ApiError> {
    let principal = auth.require_session()?;
    let service = state.lock_service();
    let items = service
        .store()
        .list_passkeys(principal.user_id)?
        .into_iter()
        .map(PasskeyResponse::from)
        .collect();
    Ok(Json(PasskeyListResponse { items }))
}

/// Begins registration of a new passkey. Requires a browser session.
pub async fn registration_begin(
    State(state): State<AppState>,
    auth: Auth,
) -> Result<Json<PasskeyChallengeResponse>, ApiError> {
    let principal = auth.require_session()?;
    let webauthn = require_webauthn(&state)?;
    let service = state.lock_service();
    let user = service
        .store()
        .get_user_by_id(principal.user_id)?
        .ok_or_else(|| ApiError::unauthorized("no management user"))?;
    let exclude: Vec<_> = service
        .store()
        .list_passkeys(principal.user_id)?
        .iter()
        .filter_map(|record| serde_json::from_str::<Passkey>(&record.credential).ok())
        .map(|passkey| passkey.cred_id().clone())
        .collect();

    let (challenge, registration) = webauthn
        .start_passkey_registration(
            user.id.as_uuid(),
            &user.username,
            &user.primary_address,
            Some(exclude),
        )
        .map_err(|error| ApiError::bad_request("passkey", error.to_string()))?;

    let state_id = random_secret(24);
    state
        .passkey_state
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(
            state_id.clone(),
            PasskeyFlow::Registration {
                user_id: principal.user_id,
                registration,
            },
        );
    Ok(Json(PasskeyChallengeResponse {
        state_id,
        challenge: serde_json::to_value(&challenge)
            .map_err(|error| ApiError::internal(error.to_string()))?,
    }))
}

/// Completes passkey registration. Requires a browser session.
pub async fn registration_finish(
    State(state): State<AppState>,
    auth: Auth,
    Json(body): Json<PasskeyFinishRequest>,
) -> Result<(StatusCode, Json<PasskeyResponse>), ApiError> {
    let principal = auth.require_session()?;
    let webauthn = require_webauthn(&state)?;
    let flow = take_flow(&state, &body.state_id)?;
    let PasskeyFlow::Registration {
        user_id,
        registration,
    } = flow
    else {
        return Err(ApiError::bad_request(
            "passkey_state",
            "state does not match a registration",
        ));
    };
    if user_id != principal.user_id {
        return Err(ApiError::forbidden("state belongs to another user"));
    }

    let credential: RegisterPublicKeyCredential = serde_json::from_value(body.credential)
        .map_err(|error| ApiError::bad_request("passkey_credential", error.to_string()))?;
    let passkey = webauthn
        .finish_passkey_registration(&credential, &registration)
        .map_err(|error| ApiError::bad_request("passkey", error.to_string()))?;
    let serialized =
        serde_json::to_string(&passkey).map_err(|error| ApiError::internal(error.to_string()))?;

    let record = PasskeyRecord {
        id: uuid::Uuid::new_v4().to_string(),
        user_id,
        name: body
            .name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Passkey".to_string()),
        credential: serialized,
        created_at: state.now(),
        last_used_at: None,
    };
    let service = state.lock_service();
    service.store().insert_passkey(&record)?;
    Ok((StatusCode::CREATED, Json(PasskeyResponse::from(record))))
}

/// Begins passkey authentication.
pub async fn authentication_begin(
    State(state): State<AppState>,
) -> Result<Json<PasskeyChallengeResponse>, ApiError> {
    let webauthn = require_webauthn(&state)?;
    let service = state.lock_service();
    let user = service
        .store()
        .get_user()?
        .ok_or_else(|| ApiError::unauthorized("no management user"))?;
    let passkeys: Vec<Passkey> = service
        .store()
        .list_passkeys(user.id)?
        .iter()
        .filter_map(|record| serde_json::from_str(&record.credential).ok())
        .collect();
    if passkeys.is_empty() {
        return Err(ApiError::not_found(
            "no_passkeys",
            "no passkeys are registered",
        ));
    }

    let (challenge, authentication) = webauthn
        .start_passkey_authentication(&passkeys)
        .map_err(|error| ApiError::bad_request("passkey", error.to_string()))?;
    let state_id = random_secret(24);
    state
        .passkey_state
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(
            state_id.clone(),
            PasskeyFlow::Authentication {
                user_id: user.id,
                authentication,
            },
        );
    Ok(Json(PasskeyChallengeResponse {
        state_id,
        challenge: serde_json::to_value(&challenge)
            .map_err(|error| ApiError::internal(error.to_string()))?,
    }))
}

/// Completes passkey authentication and starts a session.
pub async fn authentication_finish(
    State(state): State<AppState>,
    Json(body): Json<PasskeyFinishRequest>,
) -> Result<(HeaderMap, Json<SessionResponse>), ApiError> {
    let webauthn = require_webauthn(&state)?;
    let flow = take_flow(&state, &body.state_id)?;
    let PasskeyFlow::Authentication {
        user_id,
        authentication,
    } = flow
    else {
        return Err(ApiError::bad_request(
            "passkey_state",
            "state does not match an authentication",
        ));
    };

    let credential: PublicKeyCredential = serde_json::from_value(body.credential)
        .map_err(|error| ApiError::bad_request("passkey_credential", error.to_string()))?;
    let result = webauthn
        .finish_passkey_authentication(&credential, &authentication)
        .map_err(|error| ApiError::unauthorized(format!("passkey rejected: {error}")))?;

    let now = state.now();
    let service = state.lock_service();
    for record in service.store().list_passkeys(user_id)? {
        let Ok(mut passkey) = serde_json::from_str::<Passkey>(&record.credential) else {
            continue;
        };
        if passkey.update_credential(&result).is_some() {
            let serialized = serde_json::to_string(&passkey)
                .map_err(|error| ApiError::internal(error.to_string()))?;
            service
                .store()
                .update_passkey_credential(&record.id, &serialized, now)?;
            break;
        }
    }

    let (session, token) = state.identity(&service).start_session(user_id)?;
    let csrf_token = session.csrf_token.clone();
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&state.config.session_cookie_header(&token))
            .map_err(|_| ApiError::internal("invalid session cookie"))?,
    );
    Ok((
        headers,
        Json(SessionResponse {
            session: SessionInfo::from(session),
            csrf_token,
        }),
    ))
}

/// Removes a registered passkey. Requires a browser session.
pub async fn delete(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let principal = auth.require_session()?;
    let service = state.lock_service();
    let Some(record) = service.store().get_passkey(&id)? else {
        return Err(ApiError::not_found(
            "passkey_not_found",
            "passkey not found",
        ));
    };
    if record.user_id != principal.user_id {
        return Err(ApiError::forbidden("passkey belongs to another user"));
    }
    service.store().delete_passkey(&id)?;
    Ok(StatusCode::NO_CONTENT)
}

fn require_webauthn(state: &AppState) -> Result<&std::sync::Arc<Webauthn>, ApiError> {
    state
        .webauthn
        .as_ref()
        .ok_or_else(|| ApiError::unavailable("passkeys are not configured"))
}

fn take_flow(state: &AppState, state_id: &str) -> Result<PasskeyFlow, ApiError> {
    state
        .passkey_state
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(state_id)
        .ok_or_else(|| ApiError::bad_request("passkey_state", "unknown or expired state"))
}
