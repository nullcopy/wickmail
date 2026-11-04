//! API token management endpoints.
//!
//! Token management requires a browser session: a bearer token cannot mint or
//! revoke credentials, so a leaked token cannot escalate its own access.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;

use crate::api::{ApiTokenResponse, CreateTokenRequest, IssuedTokenResponse, TokenListResponse};
use crate::token::{ScopeSet, TokenId, issue_token};

use super::auth::Auth;
use super::{ApiError, AppState};

/// Lists API tokens. Requires a browser session.
pub async fn list(
    State(state): State<AppState>,
    auth: Auth,
) -> Result<Json<TokenListResponse>, ApiError> {
    auth.require_session()?;
    let service = state.lock_service();
    let items = service
        .store()
        .list_api_tokens()?
        .into_iter()
        .map(ApiTokenResponse::from)
        .collect();
    Ok(Json(TokenListResponse { items }))
}

/// Issues a scoped token. The token is shown exactly once.
pub async fn create(
    State(state): State<AppState>,
    auth: Auth,
    Json(body): Json<CreateTokenRequest>,
) -> Result<(StatusCode, Json<IssuedTokenResponse>), ApiError> {
    let principal = auth.require_session()?;
    if body.scopes.is_empty() {
        return Err(ApiError::bad_request(
            "no_scopes",
            "at least one scope is required",
        ));
    }
    let scopes = ScopeSet::new(body.scopes)?;
    let issued = issue_token(
        principal.user_id,
        body.name,
        scopes,
        body.expires_at,
        state.now(),
    );
    let service = state.lock_service();
    service.store().insert_api_token(&issued.record)?;
    Ok((
        StatusCode::CREATED,
        Json(IssuedTokenResponse {
            token: issued.token,
            record: ApiTokenResponse::from(issued.record),
        }),
    ))
}

/// Revokes a token. Requires a browser session.
pub async fn revoke(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<TokenId>,
) -> Result<Json<ApiTokenResponse>, ApiError> {
    auth.require_session()?;
    let service = state.lock_service();
    let mut token = service
        .store()
        .get_api_token(id)?
        .ok_or_else(|| ApiError::not_found("token_not_found", "token not found"))?;
    service.store().revoke_api_token(id, state.now())?;
    token.revoked_at = Some(state.now());
    Ok(Json(ApiTokenResponse::from(token)))
}
