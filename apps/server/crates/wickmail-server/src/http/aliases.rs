//! Alias management endpoints.

use std::cmp::Ordering;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::Deserialize;

use crate::alias::{Alias, AliasId, AliasState};
use crate::api::{
    AliasEventResponse, AliasListResponse, AliasResponse, CreateAliasRequest, DurationRequest,
    EnableRequest, SetExpiryRequest, UpdateAliasRequest,
};
use crate::audit::derived_expired_event;
use crate::timestamp::Timestamp;
use crate::token::Scope;

use super::auth::Auth;
use super::{ApiError, AppState, decode_cursor, encode_cursor, page_size};

/// Query parameters for `GET /v1/aliases`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAliasesQuery {
    /// Comma-separated states: `active`, `expired`, `disabled`.
    pub state: Option<String>,
    /// Case-insensitive search over label, purpose, and address.
    pub search: Option<String>,
    /// Filter by presence or absence of an expiry.
    pub has_expiry: Option<bool>,
    /// Only aliases expiring at or before this instant.
    pub expires_before: Option<Timestamp>,
    /// Only aliases expiring at or after this instant.
    pub expires_after: Option<Timestamp>,
    /// Sort key: `expires`, `lastUsed`, or `created`.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc`.
    pub order: Option<String>,
    /// Page size.
    pub limit: Option<usize>,
    /// Opaque pagination cursor.
    pub cursor: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AliasSort {
    Expires,
    LastUsed,
    Created,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SortOrder {
    Asc,
    Desc,
}

impl SortOrder {
    fn parse(value: Option<&str>) -> Self {
        match value {
            Some("desc") | Some("DESC") => SortOrder::Desc,
            _ => SortOrder::Asc,
        }
    }
}

/// Creates an alias. Requires `aliases:write`.
pub async fn create(
    State(state): State<AppState>,
    auth: Auth,
    Json(body): Json<CreateAliasRequest>,
) -> Result<(StatusCode, Json<AliasResponse>), ApiError> {
    auth.require_scope(Scope::AliasesWrite)?;
    let service = state.lock_service();
    let alias = service.create(body.into())?;
    let response = AliasResponse::from_alias(&alias, service.now());
    Ok((StatusCode::CREATED, Json(response)))
}

/// Lists aliases with filtering, sorting, and pagination.
pub async fn list(
    State(state): State<AppState>,
    auth: Auth,
    Query(query): Query<ListAliasesQuery>,
) -> Result<Json<AliasListResponse>, ApiError> {
    auth.require_scope(Scope::AliasesRead)?;
    let service = state.lock_service();
    let now = service.now();
    let aliases = service.list()?;

    let sort = sort_for(&query);
    let states: Option<Vec<AliasState>> = query.state.as_deref().map(parse_states);
    let search = query.search.as_deref().map(str::to_lowercase);

    let mut entries: Vec<(Alias, AliasResponse, SortKey)> = aliases
        .into_iter()
        .filter(|alias| {
            states
                .as_ref()
                .is_none_or(|states| states.contains(&crate::lease::evaluate_state(alias, now)))
        })
        .filter(|alias| match query.has_expiry {
            Some(true) => alias.expires_at.is_some(),
            Some(false) => alias.expires_at.is_none(),
            None => true,
        })
        .filter(|alias| {
            query
                .expires_before
                .is_none_or(|bound| alias.expires_at.is_some_and(|value| value <= bound))
        })
        .filter(|alias| {
            query
                .expires_after
                .is_none_or(|bound| alias.expires_at.is_some_and(|value| value >= bound))
        })
        .filter(|alias| {
            search
                .as_deref()
                .is_none_or(|needle| matches_search(alias, needle))
        })
        .map(|alias| {
            let key = sort_key(&alias, sort);
            let response = AliasResponse::from_alias(&alias, now);
            (alias, response, key)
        })
        .collect();

    let order = SortOrder::parse(query.order.as_deref());
    entries.sort_by(|left, right| compare(&left.2, left.0.id, &right.2, right.0.id, order));

    if let Some(cursor) = query.cursor.as_deref().and_then(decode_cursor)
        && let Some((key, id)) = cursor_key(&cursor, sort)
    {
        entries.retain(|(alias, _, item_key)| {
            compare(item_key, alias.id, &key, id, order) == Ordering::Greater
        });
    }

    let limit = page_size(query.limit);
    let truncated = entries.len() > limit;
    let mut items: Vec<AliasResponse> = Vec::new();
    let mut last: Option<(SortKey, AliasId)> = None;
    for (index, (alias, response, key)) in entries.into_iter().enumerate() {
        if index == limit {
            break;
        }
        last = Some((key, alias.id));
        items.push(response);
    }
    let next_cursor = if truncated {
        last.map(|(key, id)| encode_cursor(&cursor_json(&key, id)))
    } else {
        None
    };

    Ok(Json(AliasListResponse { items, next_cursor }))
}

/// Loads one alias.
pub async fn get(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<AliasId>,
) -> Result<Json<AliasResponse>, ApiError> {
    auth.require_scope(Scope::AliasesRead)?;
    let service = state.lock_service();
    let alias = service
        .get(id)?
        .ok_or_else(|| ApiError::not_found("alias_not_found", "alias not found"))?;
    Ok(Json(AliasResponse::from_alias(&alias, service.now())))
}

/// Edits label, purpose, and renewal policy.
pub async fn update(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<AliasId>,
    Json(body): Json<UpdateAliasRequest>,
) -> Result<Json<AliasResponse>, ApiError> {
    auth.require_scope(Scope::AliasesWrite)?;
    let service = state.lock_service();
    let alias = service.update_metadata(id, body)?;
    Ok(Json(AliasResponse::from_alias(&alias, service.now())))
}

/// Renews an alias.
pub async fn renew(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<AliasId>,
    body: Option<Json<DurationRequest>>,
) -> Result<Json<AliasResponse>, ApiError> {
    auth.require_scope(Scope::AliasesWrite)?;
    let seconds = body.map(|Json(body)| body.seconds).unwrap_or_default();
    let service = state.lock_service();
    let alias = service.renew(id, seconds)?;
    Ok(Json(AliasResponse::from_alias(&alias, service.now())))
}

/// Extends an unexpired lease.
pub async fn extend(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<AliasId>,
    body: Option<Json<DurationRequest>>,
) -> Result<Json<AliasResponse>, ApiError> {
    auth.require_scope(Scope::AliasesWrite)?;
    let seconds = body.map(|Json(body)| body.seconds).unwrap_or_default();
    let service = state.lock_service();
    let alias = service.extend(id, seconds)?;
    Ok(Json(AliasResponse::from_alias(&alias, service.now())))
}

/// Sets an absolute expiry.
pub async fn set_expiry(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<AliasId>,
    Json(body): Json<SetExpiryRequest>,
) -> Result<Json<AliasResponse>, ApiError> {
    auth.require_scope(Scope::AliasesWrite)?;
    let service = state.lock_service();
    let alias = service.set_expiry(id, body.expires_at)?;
    Ok(Json(AliasResponse::from_alias(&alias, service.now())))
}

/// Removes the expiry.
pub async fn remove_expiry(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<AliasId>,
) -> Result<Json<AliasResponse>, ApiError> {
    auth.require_scope(Scope::AliasesWrite)?;
    let service = state.lock_service();
    let alias = service.remove_expiry(id)?;
    Ok(Json(AliasResponse::from_alias(&alias, service.now())))
}

/// Disables an alias.
pub async fn disable(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<AliasId>,
) -> Result<Json<AliasResponse>, ApiError> {
    auth.require_scope(Scope::AliasesWrite)?;
    let service = state.lock_service();
    let alias = service.disable(id)?;
    Ok(Json(AliasResponse::from_alias(&alias, service.now())))
}

/// Enables a disabled alias.
pub async fn enable(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<AliasId>,
    body: Option<Json<EnableRequest>>,
) -> Result<Json<AliasResponse>, ApiError> {
    auth.require_scope(Scope::AliasesWrite)?;
    let expires_at = body.and_then(|Json(body)| body.expires_at);
    let service = state.lock_service();
    let alias = service.enable(id, expires_at)?;
    Ok(Json(AliasResponse::from_alias(&alias, service.now())))
}

/// Lists an alias's lifecycle events, including the derived expiration event.
pub async fn events(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<AliasId>,
) -> Result<Json<Vec<AliasEventResponse>>, ApiError> {
    auth.require_scope(Scope::AliasesRead)?;
    let service = state.lock_service();
    let alias = service
        .get(id)?
        .ok_or_else(|| ApiError::not_found("alias_not_found", "alias not found"))?;
    let mut events = service.events(id)?;
    if let Some(derived) = derived_expired_event(&alias, service.now()) {
        events.push(derived);
    }
    events.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then(left.id.cmp(&right.id))
    });
    Ok(Json(
        events.into_iter().map(AliasEventResponse::from).collect(),
    ))
}

fn parse_states(value: &str) -> Vec<AliasState> {
    value
        .split(',')
        .filter_map(|part| match part.trim() {
            "active" => Some(AliasState::Active),
            "expired" => Some(AliasState::Expired),
            "disabled" => Some(AliasState::Disabled),
            _ => None,
        })
        .collect()
}

fn matches_search(alias: &Alias, needle: &str) -> bool {
    let address = alias.address.as_str().to_lowercase();
    address.contains(needle)
        || alias
            .label
            .as_deref()
            .is_some_and(|label| label.to_lowercase().contains(needle))
        || alias
            .purpose
            .as_deref()
            .is_some_and(|purpose| purpose.to_lowercase().contains(needle))
}

#[derive(Clone, Copy, Debug)]
struct SortKey {
    kind: AliasSort,
    value: Option<i64>,
}

fn sort_for(query: &ListAliasesQuery) -> AliasSort {
    match query.sort.as_deref() {
        Some("expires") => AliasSort::Expires,
        Some("created") => AliasSort::Created,
        _ => AliasSort::LastUsed,
    }
}

fn sort_key(alias: &Alias, sort: AliasSort) -> SortKey {
    let value = match sort {
        AliasSort::Expires => alias.expires_at.map(Timestamp::unix_millis),
        AliasSort::LastUsed => Some(alias.last_used_at().unix_millis()),
        AliasSort::Created => Some(alias.created_at.unix_millis()),
    };
    SortKey { kind: sort, value }
}

fn compare(
    left: &SortKey,
    left_id: AliasId,
    right: &SortKey,
    right_id: AliasId,
    order: SortOrder,
) -> Ordering {
    let key_order = match (left.value, right.value) {
        (None, None) => Ordering::Equal,
        // No-expiry aliases sort last in either direction.
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(a), Some(b)) => {
            let base = a.cmp(&b);
            if order == SortOrder::Desc {
                base.reverse()
            } else {
                base
            }
        }
    };
    key_order.then_with(|| left_id.cmp(&right_id))
}

fn cursor_json(key: &SortKey, id: AliasId) -> serde_json::Value {
    let sort = match key.kind {
        AliasSort::Expires => "expires",
        AliasSort::LastUsed => "lastUsed",
        AliasSort::Created => "created",
    };
    serde_json::json!({
        "sort": sort,
        "value": key.value,
        "id": id.to_string(),
    })
}

fn cursor_key(cursor: &serde_json::Value, sort: AliasSort) -> Option<(SortKey, AliasId)> {
    let id = cursor.get("id")?.as_str()?.parse().ok()?;
    let value = match cursor.get("value")? {
        serde_json::Value::Null => None,
        other => Some(other.as_i64()?),
    };
    Some((SortKey { kind: sort, value }, id))
}
