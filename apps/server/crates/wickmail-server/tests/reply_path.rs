//! End-to-end test of the reply-as-alias outbound path.
//!
//! Delivers a message into a Maildir, fetches sanitized reply context, and
//! submits a reply through the reply client. It exercises provenance-based
//! identity selection, outbound identity enforcement, DKIM signing, and
//! renewal-after-acceptance without a NixOS VM.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rsa::RsaPublicKey;
use wickmail_server::address::{CanonicalAddress, Domain};
use wickmail_server::alias::{Alias, AliasId};
use wickmail_server::api::{ReplyIdentityOption, ReplyIdentitySelection, ReplyRequest};
use wickmail_server::clock::{FixedClock, SharedClock};
use wickmail_server::db::Store;
use wickmail_server::generator::AliasGenerator;
use wickmail_server::mail::headers::MessageParts;
use wickmail_server::mail::store::MailStoreAdapter;
use wickmail_server::message::{Message, MessageId, Route};
use wickmail_server::reply::{
    DkimSigner, FileOutboundQueue, OutboundQueue, ReplyClient, ReplyError, public_key_from_pem,
    verify_dkim,
};
use wickmail_server::service::AliasService;
use wickmail_server::timestamp::Timestamp;

const NOW: &str = "2026-01-04T00:00:00Z";
const PRIMARY: &str = "user@example.com";

const PRIVATE_PEM: &str = r"-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCg7++shN364cBD
GKvjV520pSfVRalyO8sjj3pntRVTk2RedMapEfLe2/iAy6Xa0v1+k2lAwbTYtHEQ
Vp3ks52ThRIjUriRPu2b/s3cYOB44N823Gv1Ey1z83ghxvc2EjEK0FD1zYdLFCvQ
+++BbYxnwH7QPRDOk7HlKQ7QFMy8OJSBjTr99qvMRmxET792e91RJorRPaPHOH7X
WBAxPrbq5kBhAwMSVC2YnlLjmQ7LW5aB2QrV4ayNBSQPZNXm3EOILanc4XeyEYOh
HnFS0fNHcdQosSJHM2ODPNwfXHbrD3mG4dhLI8qPMY5NBSxCTdbAzS4zTp0sN/FU
O/3dplOnAgMBAAECggEARbYo923GSbon8ehp7Fwzb+BqVLOMJnNIFus7dli2GDGs
NE4ZD3s63NYj2oZcHWFvdLidyvMdRxFCOHWMh1hWVWQ66xoV4LSFcCD7Qw6jrTia
98Sa7tmTwrofu2HYC4/ttmVt7EtO43KlWC0JHeM6Amcbh1AsS48ma8FRLUkVNiIM
KvaHn+GN/S+kpgg+Z5zQDNbG1/YGAR19KynvFLLBE5upbmpBSLeiHYHTZ59JFZiy
H3bXEvsZw/N/KbZfSZhwTdri2GT+QAn4StrAMVR4jaCsPNIZysSaPnrB3QVJU7um
ECRvauSbpC/LQ/Rmg3XtPKBJg3ZRUmgAULKiNk0g4QKBgQDQJ47jxyCS9Ci0a+lY
1bEYo0VEtQ7bcOmENBneiK7hvFaYCUg853pbT+Q23sDfQJHBUu2U1dCozwZFwIfA
w487r87WCuTWLOsI9ucvZVST3lh3auh640yNp8z4apGrY5Alyr8j8/MxnuUzFvEt
aLmjVJJ9RKU5rcmL19xY4LfGkwKBgQDF7fiLv65mxSnuC7jI0PRl3kM2CJaK83oZ
ngVJ8mt+Hq7ZokGcxDgNCM8F0mRjutHX2ePvZpktmAA2BfL4EIKUbni4csufM8VV
3U1FELCKkb2djGqzLYUuNGqn8AeEtipKSTmdJxHzJYJJynrG+e5fn54VymlIShRW
VFf4l+/3HQKBgFM/HtRVtN9Qql7NsXsHq1XxJii+SHzWgW2P8LCg9V/uFKulOrCw
2qxeHSUcnQIsLp6kbcPSZyq78QRAZYpgK45xV0UfAjntqOni5L59xf+FMtg/d05+
TQVyEHVhGXTz0phqp1rXm3FC3OM7z6Sbd3KsxhE3POT+bdZxs/wPky/lAoGAMtmJ
YjXTk3mR5SNDzOvJ7iXk9IvOSVJ2CwDK8Q2DyjoNx8Hkw2ax079wmFlOC0Uixian
ZYjhT5Jec4KhwlNTiNi80P5FC9icGQwq3tSD1oXMxh4eB3xpW86BnDWRaOn4AW/A
inxQIzx+tYB8fIQXVp/GWGjRFY5anTc8BpTaRI0CgYAKAPiyPwRdeZek0NVYz9Ax
MNOtjjdiooDlYLRE9S6OUJgt3OZ6Ni9gVslRxBsQWkKOCo7OfvbDuCFZFxrNyjIY
G6wxmMgyzFNUWhaHF1cZQO8McSjtWuVuELBs3BjrIVK4U4NRqUOBLqfDuRTzqmtJ
VcPuve5VX2kGdvXlf4cpFw==
-----END PRIVATE KEY-----
";

const PUBLIC_PEM: &str = r"-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoO/vrITd+uHAQxir41ed
tKUn1UWpcjvLI496Z7UVU5NkXnTGqRHy3tv4gMul2tL9fpNpQMG02LRxEFad5LOd
k4USI1K4kT7tm/7N3GDgeODfNtxr9RMtc/N4Icb3NhIxCtBQ9c2HSxQr0PvvgW2M
Z8B+0D0QzpOx5SkO0BTMvDiUgY06/farzEZsRE+/dnvdUSaK0T2jxzh+11gQMT62
6uZAYQMDElQtmJ5S45kOy1uWgdkK1eGsjQUkD2TV5txDiC2p3OF3shGDoR5xUtHz
R3HUKLEiRzNjgzzcH1x26w95huHYSyPKjzGOTQUsQk3WwM0uM06dLDfxVDv93aZT
pwIDAQAB
-----END PUBLIC KEY-----
";

fn at(value: &str) -> Timestamp {
    value.parse().unwrap()
}

fn address(value: &str) -> CanonicalAddress {
    CanonicalAddress::parse(value).unwrap()
}

struct Harness {
    _dir: tempfile::TempDir,
    service: Arc<Mutex<AliasService>>,
    maildir: PathBuf,
    queue: Arc<dyn OutboundQueue>,
    client: ReplyClient,
    public: RsaPublicKey,
}

impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("wickmail.sqlite")).unwrap();
        store.migrate().unwrap();
        let clock: SharedClock = Arc::new(FixedClock::new(at(NOW)));
        let service = Arc::new(Mutex::new(AliasService::new(
            store,
            AliasGenerator::new(),
            Domain::parse("example.com").unwrap(),
            clock.clone(),
        )));

        let maildir = dir.path().join("Maildir");
        fs::create_dir_all(maildir.join("cur")).unwrap();
        let mail = MailStoreAdapter::open(&maildir);

        let queue_dir = dir.path().join("outbound");
        let queue: Arc<dyn OutboundQueue> = Arc::new(FileOutboundQueue::open(&queue_dir).unwrap());
        let dkim = DkimSigner::from_pem(
            Domain::parse("example.com").unwrap(),
            "wickmail",
            PRIVATE_PEM,
        )
        .unwrap();
        let client = ReplyClient::new(
            service.clone(),
            mail,
            queue.clone(),
            Some(dkim),
            Some(address(PRIMARY)),
            clock,
        );
        let public = public_key_from_pem(PUBLIC_PEM).unwrap();

        Self {
            _dir: dir,
            service,
            maildir,
            queue,
            client,
            public,
        }
    }

    fn create_alias(&self, local: &str, expires_at: Timestamp, renew: bool) -> Alias {
        let alias = Alias {
            id: AliasId::new(),
            address: address(local),
            label: None,
            purpose: None,
            created_at: at("2026-01-01T00:00:00Z"),
            expires_at: Some(expires_at),
            disabled_at: None,
            lease_duration_seconds: 3600,
            renew_on_outbound: renew,
            last_inbound_at: None,
            last_user_activity_at: None,
            policy_version: 0,
        };
        self.service
            .lock()
            .unwrap()
            .store()
            .insert_alias(&alias)
            .unwrap();
        alias
    }

    fn deliver(&self, message_id: MessageId, alias_ids: &[AliasId], primary: bool, raw: &str) {
        let contents = format!("X-Wickmail-Message-ID: {message_id}\r\n{raw}");
        fs::write(
            self.maildir.join("cur").join(message_id.to_string()),
            contents,
        )
        .unwrap();
        let service = self.service.lock().unwrap();
        service
            .store()
            .record_inbound_delivery(&Message {
                id: message_id,
                alias_ids: alias_ids.to_vec(),
                primary_received: primary,
                sender: "sender@example.net".to_string(),
                subject: "Your order".to_string(),
                received_at: at(NOW),
                route: Route::Inbox,
            })
            .unwrap();
    }

    fn stored_alias(&self, id: AliasId) -> Alias {
        self.service.lock().unwrap().get(id).unwrap().unwrap()
    }
}

fn header(raw: &[u8], name: &str) -> Option<String> {
    MessageParts::parse(raw)
        .headers
        .get(name)
        .map(|value| value.to_string())
}

#[test]
fn fetches_context_and_submits_a_signed_reply_as_the_alias() {
    let harness = Harness::new();
    let alias = harness.create_alias("green.farm@example.com", at("2026-01-05T00:00:00Z"), true);
    let message_id = MessageId::new();
    harness.deliver(
        message_id,
        &[alias.id],
        true,
        "From: Sender Name <sender@example.net>\r\nTo: green.farm@example.com\r\nSubject: Your order\r\nMessage-ID: <orig@example.net>\r\n\r\nThanks for your order.\r\n",
    );

    let context = harness
        .client
        .fetch_reply_context(message_id)
        .unwrap()
        .expect("context");
    assert_eq!(context.from.as_deref(), Some("sender@example.net"));
    assert_eq!(context.subject.as_deref(), Some("Your order"));
    assert_eq!(context.text, "Thanks for your order.");
    assert_eq!(
        context.original_message_id.as_deref(),
        Some("<orig@example.net>")
    );
    assert_eq!(context.identity.selection, ReplyIdentitySelection::Default);
    assert_eq!(
        context.identity.selected,
        Some(ReplyIdentityOption::Alias {
            alias_id: alias.id,
            address: alias.address.clone(),
        })
    );
    assert_eq!(context.identity.options.len(), 2);

    let response = harness
        .client
        .submit_reply(
            message_id,
            &ReplyRequest {
                alias_id: Some(alias.id),
                body: "You're welcome.".to_string(),
                quoted_text: Some("Thanks for your order.".to_string()),
            },
        )
        .unwrap();
    assert!(response.queued);
    assert!(response.renewed);
    assert_eq!(response.expires_at, Some(at("2026-01-04T01:00:00Z")));

    let queued = harness.queue.get(response.message_id).unwrap().unwrap();
    assert_eq!(
        header(&queued.raw, "From").as_deref(),
        Some("green.farm@example.com")
    );
    assert_eq!(
        header(&queued.raw, "To").as_deref(),
        Some("sender@example.net")
    );
    assert_eq!(header(&queued.raw, "Reply-To"), None);
    assert!(!String::from_utf8_lossy(&queued.raw).contains("X-Wickmail-"));
    assert!(verify_dkim(&queued.raw, &harness.public).valid);

    // The alias renewed after the message was queued.
    assert_eq!(
        harness.stored_alias(alias.id).expires_at,
        Some(at("2026-01-04T01:00:00Z"))
    );
}

#[test]
fn multiple_aliases_prompt_and_never_select_silently() {
    let harness = Harness::new();
    let first = harness.create_alias("green.farm@example.com", at("2026-01-05T00:00:00Z"), true);
    let second = harness.create_alias("blue.sky@example.com", at("2026-01-05T00:00:00Z"), true);
    let message_id = MessageId::new();
    harness.deliver(
        message_id,
        &[first.id, second.id],
        true,
        "From: sender@example.net\r\nSubject: Both\r\n\r\nbody\r\n",
    );

    let context = harness
        .client
        .fetch_reply_context(message_id)
        .unwrap()
        .expect("context");
    assert_eq!(context.identity.selection, ReplyIdentitySelection::Prompt);
    assert_eq!(context.identity.selected, None);
    assert_eq!(context.identity.options.len(), 3);

    let without_choice = harness.client.submit_reply(
        message_id,
        &ReplyRequest {
            alias_id: None,
            body: "hi".to_string(),
            quoted_text: None,
        },
    );
    assert!(matches!(without_choice, Err(ReplyError::IdentityRequired)));

    let response = harness
        .client
        .submit_reply(
            message_id,
            &ReplyRequest {
                alias_id: Some(second.id),
                body: "hi".to_string(),
                quoted_text: None,
            },
        )
        .unwrap();
    let queued = harness.queue.get(response.message_id).unwrap().unwrap();
    assert_eq!(
        header(&queued.raw, "From").as_deref(),
        Some("blue.sky@example.com")
    );
}

#[test]
fn an_expired_alias_without_renewal_is_rejected() {
    let harness = Harness::new();
    let alias = harness.create_alias("old.farm@example.com", at("2026-01-03T00:00:00Z"), false);
    let message_id = MessageId::new();
    harness.deliver(
        message_id,
        &[alias.id],
        false,
        "From: sender@example.net\r\nSubject: Old\r\n\r\nbody\r\n",
    );

    let result = harness.client.submit_reply(
        message_id,
        &ReplyRequest {
            alias_id: Some(alias.id),
            body: "hi".to_string(),
            quoted_text: None,
        },
    );
    assert!(matches!(result, Err(ReplyError::Rejected(_))));
    assert!(harness.queue.list().unwrap().is_empty());
    assert_eq!(
        harness.stored_alias(alias.id).expires_at,
        Some(at("2026-01-03T00:00:00Z"))
    );
}

#[test]
fn a_primary_only_message_uses_the_primary_identity() {
    let harness = Harness::new();
    let message_id = MessageId::new();
    harness.deliver(
        message_id,
        &[],
        true,
        "From: sender@example.net\r\nSubject: Direct\r\n\r\nbody\r\n",
    );

    let context = harness
        .client
        .fetch_reply_context(message_id)
        .unwrap()
        .expect("context");
    assert_eq!(context.identity.selection, ReplyIdentitySelection::Default);
    assert_eq!(
        context.identity.selected,
        Some(ReplyIdentityOption::Primary {
            address: address(PRIMARY),
        })
    );

    let response = harness
        .client
        .submit_reply(
            message_id,
            &ReplyRequest {
                alias_id: None,
                body: "hi".to_string(),
                quoted_text: None,
            },
        )
        .unwrap();
    assert!(!response.renewed);
    assert!(response.expires_at.is_none());
    let queued = harness.queue.get(response.message_id).unwrap().unwrap();
    assert_eq!(header(&queued.raw, "From").as_deref(), Some(PRIMARY));
}

#[test]
fn a_message_without_provenance_has_no_context() {
    let harness = Harness::new();
    assert!(
        harness
            .client
            .fetch_reply_context(MessageId::new())
            .unwrap()
            .is_none()
    );
}

#[test]
fn the_primary_address_is_stripped_from_outbound_headers() {
    let harness = Harness::new();
    let alias = harness.create_alias("green.farm@example.com", at("2026-01-05T00:00:00Z"), true);
    let message_id = MessageId::new();
    harness.deliver(
        message_id,
        &[alias.id],
        false,
        "From: sender@example.net\r\nSubject: Leak\r\n\r\nbody\r\n",
    );

    // A composed reply never contains the primary address, but a client could
    // try to smuggle it through a custom header.
    let raw = b"From: green.farm@example.com\r\nTo: sender@example.net\r\nX-Real-User: user@example.com\r\n\r\nbody".to_vec();
    let response = harness
        .client
        .submit_outbound(wickmail_server::reply::SubmitOutbound {
            identity: ReplyIdentityOption::Alias {
                alias_id: alias.id,
                address: alias.address.clone(),
            },
            raw,
            recipients: vec!["sender@example.net".to_string()],
            envelope_sender: None,
            message_id: None,
        })
        .unwrap();
    let queued = harness.queue.get(response.message_id).unwrap().unwrap();
    assert_eq!(header(&queued.raw, "X-Real-User"), None);
}
