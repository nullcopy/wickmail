//! Reply endpoints.
//!
//! `reply-context` is scoped to messages the server accepted: a message without
//! trusted provenance resolves to `404`. `reply` selects an identity the
//! message's provenance allows, so a client cannot send as an unrelated alias.

use axum::Json;
use axum::extract::{Path, State};

use crate::api::{ReplyContextResponse, ReplyRequest, ReplyResponse};
use crate::message::MessageId;
use crate::token::Scope;

use super::auth::Auth;
use super::{ApiError, AppState};

/// Fetches sanitized reply context. Requires `messages:read`.
pub async fn reply_context(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<MessageId>,
) -> Result<Json<ReplyContextResponse>, ApiError> {
    auth.require_scope(Scope::MessagesRead)?;
    let service = state.lock_service();
    let context = crate::reply::fetch_reply_context(
        service.store(),
        &state.mail,
        id,
        state.primary.as_ref(),
    )?
    .ok_or_else(|| ApiError::not_found("message_not_found", "message not found"))?;
    Ok(Json(context))
}

/// Submits a reply as a provenance-allowed identity. Requires `messages:reply`.
pub async fn reply(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<MessageId>,
    Json(body): Json<ReplyRequest>,
) -> Result<Json<ReplyResponse>, ApiError> {
    auth.require_scope(Scope::MessagesReply)?;
    let service = state.lock_service();
    let response = crate::reply::submit_reply(
        &service,
        &state.mail,
        state.queue.as_ref(),
        state.dkim.as_deref(),
        state.primary.as_ref(),
        id,
        &body,
        service.now(),
    )?;
    Ok(Json(response))
}
