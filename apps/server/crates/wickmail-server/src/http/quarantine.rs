//! Quarantine management endpoints.

use std::cmp::Ordering;

use axum::Json;
use axum::extract::{Path, Query, State};
use serde::Deserialize;

use crate::alias::AliasId;
use crate::api::{QuarantineListResponse, QuarantineResponse, RecoverQuarantineRequest};
use crate::mail::headers::MessageParts;
use crate::mail::store::MailStoreAdapter;
use crate::message::MessageId;
use crate::quarantine::{
    DeleteReason, QuarantineKind, QuarantineManager, QuarantineMetadata, QuarantineStatus,
    RetentionPolicy, mailbox_for,
};
use crate::reply::sanitize::extract_text_body;
use crate::token::Scope;

use super::auth::Auth;
use super::{ApiError, AppState, decode_cursor, encode_cursor, page_size};

/// Query parameters for `GET /v1/quarantine`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuarantineQuery {
    /// Filter by kind: `lease` or `spam`.
    pub kind: Option<String>,
    /// Filter by lifecycle status.
    pub status: Option<String>,
    /// Filter by receiving alias.
    pub alias_id: Option<AliasId>,
    /// Case-insensitive search over sender and subject.
    pub search: Option<String>,
    /// Sort direction by received time: `asc` or `desc`.
    pub order: Option<String>,
    /// Page size.
    pub limit: Option<usize>,
    /// Opaque pagination cursor.
    pub cursor: Option<String>,
}

/// Lists quarantined messages. Requires `quarantine:read`.
pub async fn list(
    State(state): State<AppState>,
    auth: Auth,
    Query(query): Query<ListQuarantineQuery>,
) -> Result<Json<QuarantineListResponse>, ApiError> {
    auth.require_scope(Scope::QuarantineRead)?;
    let service = state.lock_service();
    let mut entries: Vec<QuarantineMetadata> = service.store().list_quarantine_metadata()?;

    let kind = query.kind.as_deref().and_then(parse_kind);
    let status = query.status.as_deref().and_then(parse_status);
    let search = query.search.as_deref().map(str::to_lowercase);

    entries.retain(|metadata| kind.is_none_or(|kind| metadata.kind == kind));
    entries.retain(|metadata| status.is_none_or(|status| metadata.status == status));
    entries.retain(|metadata| {
        query
            .alias_id
            .is_none_or(|alias_id| metadata.alias_ids.contains(&alias_id))
    });
    entries.retain(|metadata| {
        search.as_deref().is_none_or(|needle| {
            metadata.sender.to_lowercase().contains(needle)
                || metadata.subject.to_lowercase().contains(needle)
        })
    });

    let descending = matches!(query.order.as_deref(), Some("desc") | Some("DESC"));
    entries.sort_by(|left, right| {
        let base = left.received_at.cmp(&right.received_at);
        let base = if descending { base.reverse() } else { base };
        base.then(left.message_id.cmp(&right.message_id))
    });

    if let Some(cursor) = query.cursor.as_deref().and_then(decode_cursor)
        && let (Some(value), Some(id)) = (
            cursor.get("value").and_then(serde_json::Value::as_i64),
            cursor
                .get("id")
                .and_then(serde_json::Value::as_str)
                .and_then(|value| value.parse::<MessageId>().ok()),
        )
    {
        entries.retain(|metadata| {
            let base = metadata.received_at.unix_millis().cmp(&value);
            let base = if descending { base.reverse() } else { base };
            base.then(metadata.message_id.cmp(&id)) == Ordering::Greater
        });
    }

    let limit = page_size(query.limit);
    let truncated = entries.len() > limit;
    let mut items = Vec::new();
    let mut last: Option<(MessageId, i64)> = None;
    for (index, metadata) in entries.into_iter().enumerate() {
        if index == limit {
            break;
        }
        let value = metadata.received_at.unix_millis();
        last = Some((metadata.message_id, value));
        items.push(QuarantineResponse::from_metadata(metadata, None));
    }
    let next_cursor = if truncated {
        last.map(|(id, value)| {
            encode_cursor(&serde_json::json!({ "value": value, "id": id.to_string() }))
        })
    } else {
        None
    };

    Ok(Json(QuarantineListResponse { items, next_cursor }))
}

/// Loads one quarantined message with a sanitized preview.
pub async fn get(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<MessageId>,
) -> Result<Json<QuarantineResponse>, ApiError> {
    auth.require_scope(Scope::QuarantineRead)?;
    let service = state.lock_service();
    let metadata = service
        .store()
        .get_quarantine_metadata(id)?
        .ok_or_else(|| ApiError::not_found("quarantine_not_found", "message not found"))?;
    let preview = read_preview(&state.mail, &metadata);
    Ok(Json(QuarantineResponse::from_metadata(metadata, preview)))
}

/// Recovers a quarantined message into the inbox. Requires `quarantine:write`.
pub async fn recover(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<MessageId>,
    body: Option<Json<RecoverQuarantineRequest>>,
) -> Result<Json<QuarantineResponse>, ApiError> {
    auth.require_scope(Scope::QuarantineWrite)?;
    let request = body.map(|Json(body)| body).unwrap_or_default();
    let service = state.lock_service();
    let manager = QuarantineManager::new(
        service.store(),
        &state.mail,
        RetentionPolicy::default(),
        state.clock.clone(),
    );
    let metadata = manager.recover(id)?;

    for alias_id in &metadata.alias_ids {
        if service.get(*alias_id)?.is_none() {
            continue;
        }
        if request.enable.unwrap_or(false) {
            service.enable(*alias_id, None)?;
        }
        if request.renew.unwrap_or(false) {
            service.renew(*alias_id, None)?;
        }
        service.record_recovery(*alias_id, id)?;
    }

    let preview = read_preview(&state.mail, &metadata);
    Ok(Json(QuarantineResponse::from_metadata(metadata, preview)))
}

/// Deletes a quarantined message. Requires `quarantine:write`.
pub async fn delete(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<MessageId>,
) -> Result<Json<QuarantineResponse>, ApiError> {
    auth.require_scope(Scope::QuarantineWrite)?;
    let service = state.lock_service();
    let manager = QuarantineManager::new(
        service.store(),
        &state.mail,
        RetentionPolicy::default(),
        state.clock.clone(),
    );
    let metadata = manager.delete(id, DeleteReason::UserRequest)?;
    Ok(Json(QuarantineResponse::from_metadata(metadata, None)))
}

fn parse_kind(value: &str) -> Option<QuarantineKind> {
    match value {
        "lease" => Some(QuarantineKind::Lease),
        "spam" => Some(QuarantineKind::Spam),
        _ => None,
    }
}

fn parse_status(value: &str) -> Option<QuarantineStatus> {
    match value {
        "quarantined" => Some(QuarantineStatus::Quarantined),
        "recovering" => Some(QuarantineStatus::Recovering),
        "recovered" => Some(QuarantineStatus::Recovered),
        "deleting" => Some(QuarantineStatus::Deleting),
        "deleted" => Some(QuarantineStatus::Deleted),
        _ => None,
    }
}

fn read_preview(adapter: &MailStoreAdapter, metadata: &QuarantineMetadata) -> Option<String> {
    let mailbox = mailbox_for(metadata.kind);
    let bytes = adapter.read(mailbox, metadata.message_id).ok().flatten()?;
    let parts = MessageParts::parse(&bytes);
    Some(extract_text_body(&parts))
}
