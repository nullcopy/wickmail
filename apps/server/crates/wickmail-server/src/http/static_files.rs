//! Static web asset serving from the management API origin.
//!
//! The built Svelte app is served from the same origin as `/v1`, so the
//! browser talks to the API without CORS. Unknown non-API paths fall back to
//! `index.html` for client-side routing.

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

use super::{ApiError, AppState};

/// Serves a built asset, falling back to `index.html` for app routes.
pub async fn serve(State(state): State<AppState>, uri: Uri) -> Response {
    let path = uri.path();
    if path == "/v1" || path.starts_with("/v1/") {
        return ApiError::not_found("not_found", "no such endpoint").into_response();
    }
    let Some(root) = &state.config.web_root else {
        return ApiError::not_found("not_found", "no web assets are configured").into_response();
    };

    let relative = path.trim_start_matches('/');
    if relative
        .split('/')
        .any(|segment| segment == ".." || segment.contains('\\'))
    {
        return ApiError::bad_request("bad_path", "invalid path").into_response();
    }

    let candidate = if relative.is_empty() {
        root.join("index.html")
    } else {
        root.join(relative)
    };
    let file = if candidate.is_file() {
        candidate
    } else {
        root.join("index.html")
    };

    match std::fs::read(&file) {
        Ok(bytes) => {
            let mut response = Response::new(Body::from(bytes));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(mime_for(&file)),
            );
            response
        }
        Err(_) => (
            StatusCode::NOT_FOUND,
            ApiError::not_found("not_found", "not found").into_response(),
        )
            .into_response(),
    }
}

fn mime_for(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("map") => "application/json",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
