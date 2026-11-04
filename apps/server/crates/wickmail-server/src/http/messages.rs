//! Message list and reply endpoints.
//!
//! `GET /v1/messages` exposes a limited recent-message list of delivery
//! metadata tied to aliases and quarantine; it never returns a body.
//! `reply-context` is scoped to messages the server accepted: a message without
//! trusted provenance resolves to `404`. `reply` selects an identity the
//! message's provenance allows, so a client cannot send as an unrelated alias.

use std::cmp::Ordering;

use axum::Json;
use axum::extract::{Path, Query, State};
use serde::Deserialize;

use crate::alias::AliasId;
use crate::api::{
    MessageListResponse, MessageResponse, ReplyContextResponse, ReplyRequest, ReplyResponse,
};
use crate::message::MessageId;
use crate::timestamp::Timestamp;
use crate::token::Scope;

use super::auth::Auth;
use super::{ApiError, AppState, decode_cursor, encode_cursor, page_size};

/// Query parameters for `GET /v1/messages`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMessagesQuery {
    /// Filter by receiving alias.
    pub alias_id: Option<AliasId>,
    /// Case-insensitive search over sender and subject.
    pub search: Option<String>,
    /// Only messages received at or after this instant.
    pub received_after: Option<Timestamp>,
    /// Only messages received at or before this instant.
    pub received_before: Option<Timestamp>,
    /// Page size.
    pub limit: Option<usize>,
    /// Opaque pagination cursor.
    pub cursor: Option<String>,
}

/// Lists recent messages, newest first. Requires `messages:read`.
pub async fn list(
    State(state): State<AppState>,
    auth: Auth,
    Query(query): Query<ListMessagesQuery>,
) -> Result<Json<MessageListResponse>, ApiError> {
    auth.require_scope(Scope::MessagesRead)?;
    let service = state.lock_service();
    let mut entries = service.store().list_messages()?;

    let search = query.search.as_deref().map(str::to_lowercase);
    entries.retain(|message| {
        query
            .alias_id
            .is_none_or(|alias_id| message.alias_ids.contains(&alias_id))
    });
    entries.retain(|message| {
        query
            .received_after
            .is_none_or(|bound| message.received_at >= bound)
    });
    entries.retain(|message| {
        query
            .received_before
            .is_none_or(|bound| message.received_at <= bound)
    });
    entries.retain(|message| {
        search.as_deref().is_none_or(|needle| {
            message.sender.to_lowercase().contains(needle)
                || message.subject.to_lowercase().contains(needle)
        })
    });

    // The store returns newest first, matching the default descending order.
    if let Some(cursor) = query.cursor.as_deref().and_then(decode_cursor)
        && let (Some(value), Some(id)) = (
            cursor.get("value").and_then(serde_json::Value::as_i64),
            cursor
                .get("id")
                .and_then(serde_json::Value::as_str)
                .and_then(|value| value.parse::<MessageId>().ok()),
        )
    {
        entries.retain(|message| {
            message
                .received_at
                .unix_millis()
                .cmp(&value)
                .reverse()
                .then(message.id.cmp(&id))
                == Ordering::Greater
        });
    }

    let limit = page_size(query.limit);
    let truncated = entries.len() > limit;
    let mut items = Vec::new();
    let mut last: Option<(MessageId, i64)> = None;
    for (index, message) in entries.into_iter().enumerate() {
        if index == limit {
            break;
        }
        last = Some((message.id, message.received_at.unix_millis()));
        items.push(MessageResponse::from(message));
    }
    let next_cursor = if truncated {
        last.map(|(id, value)| {
            encode_cursor(&serde_json::json!({ "value": value, "id": id.to_string() }))
        })
    } else {
        None
    };

    Ok(Json(MessageListResponse { items, next_cursor }))
}

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
