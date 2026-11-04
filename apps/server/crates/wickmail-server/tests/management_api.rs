//! HTTP-level integration tests for the management API.
//!
//! These drive the real `axum` router with `tower::ServiceExt::oneshot`, so
//! routing, authentication, scopes, CSRF, idempotency, filtering, and static
//! serving are all exercised through the same code paths a client uses.

use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

use wickmail_server::address::{CanonicalAddress, Domain};
use wickmail_server::alias::AliasId;
use wickmail_server::api::{CreateAliasRequest, ExpiryRequest};
use wickmail_server::clock::FixedClock;
use wickmail_server::db::Store;
use wickmail_server::generator::AliasGenerator;
use wickmail_server::http::{AppState, HttpConfig, router};
use wickmail_server::identity::IdentityService;
use wickmail_server::mail::store::MailStoreAdapter;
use wickmail_server::message::{Message, MessageId, Route};
use wickmail_server::reply::MemoryOutboundQueue;
use wickmail_server::service::{AliasService, CreateAlias, ExpiryChoice};
use wickmail_server::timestamp::Timestamp;

const PASSWORD: &str = "correct horse battery";
const NOW: &str = "2026-01-04T00:00:00Z";

fn at(value: &str) -> Timestamp {
    value.parse().unwrap()
}

struct Harness {
    state: AppState,
    setup_token: String,
    maildir: tempfile::TempDir,
    _web: tempfile::TempDir,
}

impl Harness {
    fn new() -> Self {
        let mut store = Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        let service = AliasService::new(
            store,
            AliasGenerator::new(),
            Domain::parse("example.com").unwrap(),
            Arc::new(FixedClock::new(at(NOW))),
        );

        let setup_token = {
            let identity =
                IdentityService::new(service.store(), Arc::new(FixedClock::new(at(NOW))));
            identity.bootstrap("owner", "user@example.com").unwrap().1
        };

        let maildir = tempfile::tempdir().unwrap();
        let web = tempfile::tempdir().unwrap();
        std::fs::write(web.path().join("index.html"), "<html>app</html>").unwrap();
        std::fs::create_dir_all(web.path().join("assets")).unwrap();
        std::fs::write(web.path().join("assets/app.js"), "console.log('app')").unwrap();

        let mut config = HttpConfig::new(
            Domain::parse("example.com").unwrap(),
            Some(CanonicalAddress::parse("user@example.com").unwrap()),
        );
        config.web_root = Some(web.path().to_path_buf());
        config.cookie_secure = false;

        let state = AppState::new(
            Arc::new(Mutex::new(service)),
            Arc::new(MailStoreAdapter::open(maildir.path())),
            Arc::new(MemoryOutboundQueue::new()),
            config,
            Arc::new(FixedClock::new(at(NOW))),
        );

        Self {
            state,
            setup_token,
            maildir,
            _web: web,
        }
    }

    fn service(&self) -> std::sync::MutexGuard<'_, AliasService> {
        self.state.lock_service()
    }

    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        headers: &[(&str, &str)],
    ) -> (StatusCode, Value, HeaderMap) {
        let mut builder = Request::builder().method(method).uri(path);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let request = match body {
            Some(body) => builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        let response = router(self.state.clone()).oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, value, headers)
    }

    async fn setup_and_login(&self) -> (String, String) {
        let (status, _, _) = self
            .call(
                "POST",
                "/v1/setup",
                Some(json!({ "setupToken": self.setup_token, "password": PASSWORD })),
                &[],
            )
            .await;
        assert_eq!(status, StatusCode::OK, "setup should succeed");
        let (status, body, headers) = self
            .call(
                "POST",
                "/v1/sessions",
                Some(json!({ "password": PASSWORD })),
                &[],
            )
            .await;
        assert_eq!(status, StatusCode::OK, "login should succeed");
        let cookie = set_cookie(&headers);
        let csrf = body["csrfToken"].as_str().unwrap().to_string();
        (cookie, csrf)
    }
}

fn set_cookie(headers: &HeaderMap) -> String {
    headers
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

fn alias_request(label: &str) -> Value {
    serde_json::to_value(CreateAliasRequest {
        label: Some(label.to_string()),
        purpose: None,
        expiry: Some(ExpiryRequest::Lease {
            seconds: Some(86_400),
        }),
        renew_on_outbound: Some(true),
    })
    .unwrap()
}

#[tokio::test]
async fn bootstrap_prints_a_single_use_token_and_setup_sets_the_password() {
    let harness = Harness::new();

    // Setup with the wrong token is rejected.
    let (status, _, _) = harness
        .call(
            "POST",
            "/v1/setup",
            Some(json!({ "setupToken": "wrong", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, body, _) = harness
        .call(
            "POST",
            "/v1/setup",
            Some(json!({ "setupToken": harness.setup_token, "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["user"]["setupCompleted"], true);

    // The single-use token cannot be replayed.
    let (status, _, _) = harness
        .call(
            "POST",
            "/v1/setup",
            Some(json!({ "setupToken": harness.setup_token, "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn sessions_use_hardened_cookies_and_require_csrf_for_mutations() {
    let harness = Harness::new();
    let (cookie, csrf) = harness.setup_and_login().await;

    // Unauthenticated access is rejected.
    let (status, _, _) = harness.call("GET", "/v1/aliases", None, &[]).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // A cookie mutation without the CSRF header is rejected.
    let (status, _, _) = harness
        .call(
            "POST",
            "/v1/aliases",
            Some(alias_request("no csrf")),
            &[("cookie", &cookie)],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // With the CSRF token it succeeds.
    let (status, body, headers) = harness
        .call(
            "POST",
            "/v1/aliases",
            Some(alias_request("with csrf")),
            &[("cookie", &cookie), ("x-csrf-token", &csrf)],
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert!(body["address"].as_str().unwrap().ends_with("@example.com"));
    let cookie_header = headers.get(header::SET_COOKIE);
    assert!(cookie_header.is_none());
}

#[tokio::test]
async fn login_sets_a_hardened_session_cookie() {
    let harness = Harness::new();
    let (_, _, _) = harness
        .call(
            "POST",
            "/v1/setup",
            Some(json!({ "setupToken": harness.setup_token, "password": PASSWORD })),
            &[],
        )
        .await;
    let (status, _, headers) = harness
        .call(
            "POST",
            "/v1/sessions",
            Some(json!({ "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let cookie = headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Lax"));
    assert!(!cookie.contains("Secure")); // disabled for the test origin
    assert!(cookie.starts_with("wickmail_session="));

    // A wrong password is rejected.
    let (status, _, _) = harness
        .call(
            "POST",
            "/v1/sessions",
            Some(json!({ "password": "wrong" })),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn alias_list_filters_sorts_and_paginates() {
    let harness = Harness::new();
    let (cookie, csrf) = harness.setup_and_login().await;
    let auth = [("cookie", cookie.as_str()), ("x-csrf-token", csrf.as_str())];

    {
        let service = harness.service();
        service
            .create(CreateAlias {
                label: Some("alpha".to_string()),
                expiry: ExpiryChoice::LeaseSeconds(Some(3_600)),
                ..CreateAlias::default()
            })
            .unwrap();
        service
            .create(CreateAlias {
                label: Some("beta".to_string()),
                expiry: ExpiryChoice::Never,
                ..CreateAlias::default()
            })
            .unwrap();
        service
            .create(CreateAlias {
                label: Some("gamma".to_string()),
                expiry: ExpiryChoice::Absolute(at("2026-01-05T00:00:00Z")),
                ..CreateAlias::default()
            })
            .unwrap();
    }

    let (status, body, _) = harness
        .call("GET", "/v1/aliases?sort=expires&order=asc", None, &auth)
        .await;
    assert_eq!(status, StatusCode::OK);
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    // No-expiry aliases sort last.
    assert_eq!(items[0]["label"], "alpha");
    assert_eq!(items[1]["label"], "gamma");
    assert_eq!(items[2]["label"], "beta");

    let (status, body, _) = harness
        .call("GET", "/v1/aliases?search=gamma", None, &auth)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["items"].as_array().unwrap().len(), 1);

    let (status, body, _) = harness
        .call("GET", "/v1/aliases?hasExpiry=false", None, &auth)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["items"].as_array().unwrap().len(), 1);

    // Pagination returns a cursor and no overlap.
    let (status, first, _) = harness
        .call("GET", "/v1/aliases?limit=2&sort=created", None, &auth)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["items"].as_array().unwrap().len(), 2);
    let cursor = first["nextCursor"].as_str().unwrap();
    let (status, second, _) = harness
        .call(
            "GET",
            &format!("/v1/aliases?limit=2&sort=created&cursor={cursor}"),
            None,
            &auth,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let second_items = second["items"].as_array().unwrap();
    assert_eq!(second_items.len(), 1);
    assert!(second["nextCursor"].is_null());
}

#[tokio::test]
async fn scoped_tokens_are_enforced_per_endpoint() {
    let harness = Harness::new();
    let (cookie, csrf) = harness.setup_and_login().await;
    let auth = [("cookie", cookie.as_str()), ("x-csrf-token", csrf.as_str())];

    let (status, body, _) = harness
        .call(
            "POST",
            "/v1/tokens",
            Some(json!({ "name": "read only", "scopes": ["aliases:read"], "expiresAt": null })),
            &auth,
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let token = body["token"].as_str().unwrap().to_string();
    assert!(token.starts_with("wmk_"));
    assert!(body["record"]["prefix"].is_string());
    // The secret is not echoed in the record.
    assert!(body["record"]["tokenHash"].is_null());

    let bearer = format!("Bearer {token}");
    let (status, _, _) = harness
        .call("GET", "/v1/aliases", None, &[("authorization", &bearer)])
        .await;
    assert_eq!(status, StatusCode::OK);

    // The token lacks aliases:write.
    let (status, _, _) = harness
        .call(
            "POST",
            "/v1/aliases",
            Some(alias_request("token write")),
            &[("authorization", &bearer)],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // A token cannot manage credentials.
    let (status, _, _) = harness
        .call("GET", "/v1/tokens", None, &[("authorization", &bearer)])
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // The token is listed without its secret.
    let (status, body, _) = harness.call("GET", "/v1/tokens", None, &auth).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["items"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn mutations_are_idempotent_with_a_key() {
    let harness = Harness::new();
    let (cookie, csrf) = harness.setup_and_login().await;
    let auth = [
        ("cookie", cookie.as_str()),
        ("x-csrf-token", csrf.as_str()),
        ("idempotency-key", "create-1"),
    ];

    let (status, first, _) = harness
        .call("POST", "/v1/aliases", Some(alias_request("once")), &auth)
        .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, second, _) = harness
        .call("POST", "/v1/aliases", Some(alias_request("once")), &auth)
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(first["id"], second["id"]);

    let (status, body, _) = harness
        .call("GET", "/v1/aliases", None, &[("cookie", &cookie)])
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["items"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn quarantine_endpoints_require_scope_and_recover_messages() {
    let harness = Harness::new();
    let (cookie, csrf) = harness.setup_and_login().await;
    let auth = [("cookie", cookie.as_str()), ("x-csrf-token", csrf.as_str())];

    let (alias_id, message_id) = {
        let service = harness.service();
        let alias = service
            .create(CreateAlias {
                expiry: ExpiryChoice::Absolute(at("2026-01-03T00:00:00Z")),
                ..CreateAlias::default()
            })
            .unwrap();
        let message_id = MessageId::new();
        service
            .record_delivery(&Message {
                id: message_id,
                alias_ids: vec![alias.id],
                primary_received: false,
                sender: "sender@example.net".to_string(),
                subject: "held".to_string(),
                received_at: at(NOW),
                route: Route::Quarantine,
            })
            .unwrap();
        (alias.id, message_id)
    };

    // Write the quarantined body so a preview can be produced.
    let quarantine = harness.maildir.path().join(".Aliases.Expired/cur");
    std::fs::create_dir_all(&quarantine).unwrap();
    std::fs::write(
        quarantine.join("1"),
        format!("X-Wickmail-Message-ID: {message_id}\r\nSubject: held\r\n\r\nheld body\r\n"),
    )
    .unwrap();

    let (status, body, _) = harness.call("GET", "/v1/quarantine", None, &auth).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["items"].as_array().unwrap().len(), 1);
    assert_eq!(body["items"][0]["messageId"], message_id.to_string());

    let (status, body, _) = harness
        .call("GET", &format!("/v1/quarantine/{message_id}"), None, &auth)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["preview"], "held body");

    let (status, body, _) = harness
        .call(
            "POST",
            &format!("/v1/quarantine/{message_id}/recover"),
            Some(json!({ "renew": true })),
            &auth,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "recovered");
    assert!(
        body["aliasIds"]
            .as_array()
            .unwrap()
            .contains(&json!(alias_id.to_string()))
    );

    // The message moved to the inbox without duplication.
    let mut inbox_files = 0;
    for sub in ["cur", "new"] {
        if let Ok(entries) = std::fs::read_dir(harness.maildir.path().join(sub)) {
            inbox_files += entries.filter_map(Result::ok).count();
        }
    }
    assert_eq!(inbox_files, 1);
}

#[tokio::test]
async fn reply_context_is_scoped_and_reply_renews_the_alias() {
    let harness = Harness::new();
    let (cookie, csrf) = harness.setup_and_login().await;
    let auth = [("cookie", cookie.as_str()), ("x-csrf-token", csrf.as_str())];

    let message_id = {
        let service = harness.service();
        let alias = service
            .create(CreateAlias {
                expiry: ExpiryChoice::LeaseSeconds(Some(3_600)),
                ..CreateAlias::default()
            })
            .unwrap();
        let message_id = MessageId::new();
        service
            .record_delivery(&Message {
                id: message_id,
                alias_ids: vec![alias.id],
                primary_received: false,
                sender: "sender@example.net".to_string(),
                subject: "hello".to_string(),
                received_at: at(NOW),
                route: Route::Inbox,
            })
            .unwrap();
        message_id
    };

    let inbox = harness.maildir.path().join("cur");
    std::fs::create_dir_all(&inbox).unwrap();
    std::fs::write(
        inbox.join("1"),
        format!(
            "X-Wickmail-Message-ID: {message_id}\r\nFrom: Sender <sender@example.net>\r\nSubject: hello\r\n\r\nhi there\r\n"
        ),
    )
    .unwrap();

    let (status, body, _) = harness
        .call(
            "GET",
            &format!("/v1/messages/{message_id}/reply-context"),
            None,
            &auth,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["from"], "sender@example.net");
    assert_eq!(body["text"], "hi there");

    // An unknown message has no provenance.
    let (status, _, _) = harness
        .call(
            "GET",
            &format!("/v1/messages/{}/reply-context", MessageId::new()),
            None,
            &auth,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, body, _) = harness
        .call(
            "POST",
            &format!("/v1/messages/{message_id}/reply"),
            Some(json!({ "aliasId": null, "body": "thanks", "quotedText": null })),
            &auth,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["queued"], true);
    assert_eq!(body["renewed"], true);
}

#[tokio::test]
async fn messages_list_exposes_recent_delivery_metadata() {
    let harness = Harness::new();
    let (cookie, csrf) = harness.setup_and_login().await;
    let auth = [("cookie", cookie.as_str()), ("x-csrf-token", csrf.as_str())];

    let (alias_id, message_id) = {
        let service = harness.service();
        let alias = service
            .create(CreateAlias {
                expiry: ExpiryChoice::LeaseSeconds(Some(3_600)),
                ..CreateAlias::default()
            })
            .unwrap();
        let message_id = MessageId::new();
        service
            .record_delivery(&Message {
                id: message_id,
                alias_ids: vec![alias.id],
                primary_received: false,
                sender: "store@example.com".to_string(),
                subject: "Your order".to_string(),
                received_at: at(NOW),
                route: Route::Inbox,
            })
            .unwrap();
        (alias.id, message_id)
    };

    let (status, body, _) = harness.call("GET", "/v1/messages", None, &auth).await;
    assert_eq!(status, StatusCode::OK);
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["messageId"], message_id.to_string());
    assert_eq!(items[0]["sender"], "store@example.com");
    assert_eq!(items[0]["route"], "inbox");
    // The list carries delivery metadata only, never a body.
    assert!(items[0].get("body").is_none());

    // Filtering by alias narrows the list.
    let (status, body, _) = harness
        .call(
            "GET",
            &format!("/v1/messages?aliasId={alias_id}"),
            None,
            &auth,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["items"].as_array().unwrap().len(), 1);

    let (status, body, _) = harness
        .call(
            "GET",
            &format!("/v1/messages?aliasId={}", AliasId::new()),
            None,
            &auth,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["items"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn static_assets_are_served_from_the_api_origin() {
    let harness = Harness::new();
    let (status, _, headers) = harness.call("GET", "/", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "text/html; charset=utf-8");

    let (status, _, headers) = harness.call("GET", "/assets/app.js", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        headers[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .contains("javascript")
    );

    // Unknown app routes fall back to the SPA shell.
    let (status, _, _) = harness.call("GET", "/aliases/123", None, &[]).await;
    assert_eq!(status, StatusCode::OK);

    // Unknown API routes stay JSON 404s.
    let (status, _, _) = harness.call("GET", "/v1/nope", None, &[]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn mail_credential_rotation_returns_the_password_once() {
    let harness = Harness::new();
    let (cookie, csrf) = harness.setup_and_login().await;
    let auth = [("cookie", cookie.as_str()), ("x-csrf-token", csrf.as_str())];

    let (status, body, _) = harness
        .call("POST", "/v1/mail-credential", Some(json!({})), &auth)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["credential"]["configured"], true);
    assert!(body["password"].as_str().unwrap().len() >= 12);

    let (status, body, _) = harness
        .call("GET", "/v1/mail-credential", None, &auth)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["configured"], true);

    let (status, body, _) = harness
        .call("DELETE", "/v1/mail-credential", None, &auth)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["configured"], false);
}

#[tokio::test]
async fn alias_lifecycle_endpoints_round_trip() {
    let harness = Harness::new();
    let (cookie, csrf) = harness.setup_and_login().await;
    let auth = [("cookie", cookie.as_str()), ("x-csrf-token", csrf.as_str())];

    let (status, body, _) = harness
        .call(
            "POST",
            "/v1/aliases",
            Some(alias_request("lifecycle")),
            &auth,
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let id: AliasId = body["id"].as_str().unwrap().parse().unwrap();

    let (status, body, _) = harness
        .call(
            "PATCH",
            &format!("/v1/aliases/{id}"),
            Some(json!({ "label": "renamed", "purpose": null, "renewOnOutbound": false })),
            &auth,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["label"], "renamed");
    assert_eq!(body["renewOnOutbound"], false);

    let (status, _, _) = harness
        .call("POST", &format!("/v1/aliases/{id}/renew"), None, &auth)
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = harness
        .call("POST", &format!("/v1/aliases/{id}/disable"), None, &auth)
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body, _) = harness
        .call("POST", &format!("/v1/aliases/{id}/enable"), None, &auth)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["state"], "active");

    let (status, body, _) = harness
        .call("GET", &format!("/v1/aliases/{id}/events"), None, &auth)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.as_array().unwrap().len() >= 4);

    // Unknown aliases are 404s.
    let (status, _, _) = harness
        .call(
            "GET",
            &format!("/v1/aliases/{}", AliasId::new()),
            None,
            &auth,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
