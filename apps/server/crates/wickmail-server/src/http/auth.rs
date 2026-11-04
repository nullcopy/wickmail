//! Request authentication for the management API.
//!
//! A request authenticates either as a browser session (a `Secure`,
//! `HttpOnly`, `SameSite` cookie) or as a scoped bearer token. Session
//! principals carry full access; token principals are limited to their scope
//! set. Cookie-authenticated mutations must echo the session's CSRF token in
//! the `X-CSRF-Token` header.

use axum::extract::FromRequestParts;
use axum::http::header;
use axum::http::request::Parts;

use crate::identity::{SessionId, UserId};
use crate::token::{Scope, ScopeSet, TokenId, split_token, token_hash};

use super::{ApiError, AppState, is_mutating};

/// Header carrying the CSRF token for cookie-authenticated mutations.
pub const CSRF_HEADER: &str = "x-csrf-token";

/// The authenticated principal for a request.
#[derive(Clone, Debug)]
pub struct Auth(pub Principal);

/// A browser session principal.
#[derive(Clone, Debug)]
pub struct SessionPrincipal {
    /// Session identifier.
    pub session_id: SessionId,
    /// Owning user.
    pub user_id: UserId,
    /// CSRF token the client must echo.
    pub csrf_token: String,
}

/// A bearer token principal.
#[derive(Clone, Debug)]
pub struct TokenPrincipal {
    /// Token identifier.
    pub token_id: TokenId,
    /// Granted scopes.
    pub scopes: ScopeSet,
}

/// How a request authenticated.
#[derive(Clone, Debug)]
pub enum Principal {
    /// A browser session with full access.
    Session(SessionPrincipal),
    /// A scoped API token.
    Token(TokenPrincipal),
}

impl Auth {
    /// Requires a scope. Sessions always pass.
    pub fn require_scope(&self, scope: Scope) -> Result<(), ApiError> {
        match &self.0 {
            Principal::Session(_) => Ok(()),
            Principal::Token(token) if token.scopes.contains(scope) => Ok(()),
            Principal::Token(_) => Err(ApiError::forbidden(format!(
                "token is missing the {scope} scope"
            ))),
        }
    }

    /// Requires a browser session. Bearer tokens are rejected so a token
    /// cannot mint or revoke other credentials.
    pub fn require_session(&self) -> Result<&SessionPrincipal, ApiError> {
        match &self.0 {
            Principal::Session(session) => Ok(session),
            Principal::Token(_) => Err(ApiError::forbidden(
                "this operation requires a browser session",
            )),
        }
    }

    /// The session principal, when authenticated by cookie.
    pub fn session(&self) -> Option<&SessionPrincipal> {
        match &self.0 {
            Principal::Session(session) => Some(session),
            Principal::Token(_) => None,
        }
    }
}

impl FromRequestParts<AppState> for Auth {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let headers = &parts.headers;

        if let Some(value) = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
        {
            return authenticate_token(state, value.trim()).map(Auth);
        }

        let Some(token) = super::cookie_value(headers, &state.config.session_cookie) else {
            return Err(ApiError::unauthorized("authentication required"));
        };

        let session = {
            let service = state.lock_service();
            let identity = state.identity(&service);
            identity
                .authenticate_session(&token)?
                .ok_or_else(|| ApiError::unauthorized("session is not valid"))?
        };

        if is_mutating(&parts.method) {
            let provided = headers
                .get(CSRF_HEADER)
                .and_then(|value| value.to_str().ok());
            if provided != Some(session.csrf_token.as_str()) {
                return Err(ApiError::csrf());
            }
        }

        Ok(Auth(Principal::Session(SessionPrincipal {
            session_id: session.id,
            user_id: session.user_id,
            csrf_token: session.csrf_token,
        })))
    }
}

fn authenticate_token(state: &AppState, token: &str) -> Result<Principal, ApiError> {
    let Some((_prefix, _secret)) = split_token(token) else {
        return Err(ApiError::unauthorized("malformed token"));
    };
    let service = state.lock_service();
    let store = service.store();
    let Some(record) = store.get_api_token_by_hash(&token_hash(token))? else {
        return Err(ApiError::unauthorized("unknown token"));
    };
    if !record.is_live(state.now()) {
        return Err(ApiError::unauthorized("token is expired or revoked"));
    }
    store.touch_api_token(record.id, state.now())?;
    Ok(Principal::Token(TokenPrincipal {
        token_id: record.id,
        scopes: record.scopes,
    }))
}

#[cfg(test)]
mod tests {
    use super::{Auth, CSRF_HEADER, Principal};
    use crate::token::{Scope, ScopeSet};

    #[test]
    fn sessions_have_every_scope_and_tokens_are_limited() {
        let session = Auth(Principal::Session(super::SessionPrincipal {
            session_id: crate::identity::SessionId::new(),
            user_id: crate::identity::UserId::new(),
            csrf_token: "csrf".to_string(),
        }));
        assert!(session.require_scope(Scope::AliasesWrite).is_ok());
        assert!(session.require_session().is_ok());

        let token = Auth(Principal::Token(super::TokenPrincipal {
            token_id: crate::token::TokenId::new(),
            scopes: ScopeSet::new([Scope::AliasesRead]).unwrap(),
        }));
        assert!(token.require_scope(Scope::AliasesRead).is_ok());
        assert!(token.require_scope(Scope::AliasesWrite).is_err());
        assert!(token.require_session().is_err());
    }

    #[test]
    fn csrf_header_name_is_stable() {
        assert_eq!(CSRF_HEADER, "x-csrf-token");
    }
}
