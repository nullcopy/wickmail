//! End-to-end test of the inbound mail path without NixOS.
//!
//! Runs the LMTP proxy against a mock Dovecot, exercising header stripping,
//! delivery-time routing, durable spooling, and provenance recording. The
//! NixOS VM test covers the same path with real Postfix, Rspamd, and Dovecot.

use std::os::unix::net::UnixListener;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use wickmail_server::address::{CanonicalAddress, Domain};
use wickmail_server::alias::AliasState;
use wickmail_server::clock::FixedClock;
use wickmail_server::db::Store;
use wickmail_server::generator::AliasGenerator;
use wickmail_server::lease::evaluate_state;
use wickmail_server::mail::lmtp::{bind as bind_lmtp, serve_session};
use wickmail_server::mail::{
    Envelope, LmtpClient, LmtpTarget, MailPath, MessageHandler, PolicyDecision, RecipientPolicy,
    RecipientReply, Spool,
};
use wickmail_server::message::Route;
use wickmail_server::service::{AliasService, CreateAlias, ExpiryChoice};
use wickmail_server::timestamp::Timestamp;

fn at(value: &str) -> Timestamp {
    value.parse().unwrap()
}

fn address(value: &str) -> CanonicalAddress {
    CanonicalAddress::parse(value).unwrap()
}

struct RecordingDovecot {
    envelopes: Arc<Mutex<Vec<Envelope>>>,
}

impl MessageHandler for RecordingDovecot {
    fn handle(&self, envelope: Envelope) -> Vec<RecipientReply> {
        let count = envelope.recipients.len();
        self.envelopes.lock().unwrap().push(envelope);
        vec![RecipientReply::accepted("2.0.0 Ok"); count]
    }
}

fn spawn_lmtp(listener: UnixListener, handler: Arc<dyn MessageHandler>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let handler = handler.clone();
            std::thread::spawn(move || {
                let _ = serve_session(stream, handler.as_ref());
            });
        }
    })
}

struct Fixture {
    _dir: tempfile::TempDir,
    path: Arc<MailPath>,
    service: Arc<Mutex<AliasService>>,
    dovecot: Arc<Mutex<Vec<Envelope>>>,
    ingress: LmtpClient,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path().join("wickmail.sqlite")).unwrap();
        store.migrate().unwrap();
        let service = AliasService::new(
            store,
            AliasGenerator::new(),
            Domain::parse("example.com").unwrap(),
            Arc::new(FixedClock::new(at("2026-01-04T00:00:00Z"))),
        );

        // One active alias, one expired alias, one disabled alias.
        service
            .create_with_address(
                address("green.farm@example.com"),
                CreateAlias {
                    expiry: ExpiryChoice::LeaseSeconds(None),
                    ..CreateAlias::default()
                },
            )
            .unwrap();
        service
            .create_with_address(
                address("blue.sky@example.com"),
                CreateAlias {
                    expiry: ExpiryChoice::LeaseSeconds(None),
                    ..CreateAlias::default()
                },
            )
            .unwrap();
        service
            .create_with_address(
                address("old.farm@example.com"),
                CreateAlias {
                    expiry: ExpiryChoice::Absolute(at("2026-01-02T00:00:00Z")),
                    ..CreateAlias::default()
                },
            )
            .unwrap();
        let disabled = service
            .create_with_address(
                address("off.farm@example.com"),
                CreateAlias {
                    expiry: ExpiryChoice::LeaseSeconds(None),
                    ..CreateAlias::default()
                },
            )
            .unwrap();
        service.disable(disabled.id).unwrap();

        let service = Arc::new(Mutex::new(service));
        let primary = address("user@example.com");
        let policy = Arc::new(RecipientPolicy::new(primary.clone(), service.clone()));

        let dovecot = Arc::new(Mutex::new(Vec::new()));
        let dovecot_socket = dir.path().join("dovecot.sock");
        spawn_lmtp(
            bind_lmtp(&dovecot_socket).unwrap(),
            Arc::new(RecordingDovecot {
                envelopes: dovecot.clone(),
            }),
        );

        let spool = Arc::new(Spool::open(dir.path().join("spool"), 100).unwrap());
        let dovecot_client = LmtpClient::new(LmtpTarget::Unix(dovecot_socket), "wickmail");
        let path = Arc::new(MailPath::new(
            policy,
            spool,
            Arc::new(dovecot_client),
            service.clone(),
            primary,
            Arc::new(FixedClock::new(at("2026-01-04T00:00:00Z"))),
        ));

        let proxy_socket = dir.path().join("proxy.sock");
        spawn_lmtp(bind_lmtp(&proxy_socket).unwrap(), path.clone());
        let ingress = LmtpClient::new(LmtpTarget::Unix(proxy_socket), "postfix");

        Self {
            _dir: dir,
            path,
            service,
            dovecot,
            ingress,
        }
    }

    fn send(&self, recipient: &str, data: &[u8]) {
        self.send_from("sender@example.com", recipient, data);
    }

    fn send_from(&self, sender: &str, recipient: &str, data: &[u8]) {
        self.ingress.deliver(sender, recipient, data).unwrap();
        self.path.forward_pending().unwrap();
    }

    fn delivered(&self) -> Vec<Envelope> {
        self.dovecot.lock().unwrap().clone()
    }
}

#[test]
fn active_alias_is_delivered_to_the_inbox() {
    let fixture = Fixture::new();
    fixture.send(
        "green.farm@example.com",
        b"From: sender@example.com\r\nSubject: hi\r\n\r\nhello\r\n",
    );

    let envelopes = fixture.delivered();
    assert_eq!(envelopes.len(), 1);
    assert_eq!(envelopes[0].recipients, vec!["user@example.com"]);
    let text = String::from_utf8_lossy(&envelopes[0].data);
    assert!(text.contains("X-Wickmail-Route: Inbox\r\n"), "{text}");
    assert!(text.contains("X-Wickmail-Message-ID: "), "{text}");
    assert!(text.contains("X-Wickmail-Alias-ID: "), "{text}");

    let message_id = header(&text, "X-Wickmail-Message-ID").unwrap();
    let stored = fixture
        .service
        .lock()
        .unwrap()
        .store()
        .get_message(message_id.parse().unwrap())
        .unwrap()
        .expect("provenance recorded");
    assert_eq!(stored.route, Route::Inbox);
    assert_eq!(stored.alias_ids.len(), 1);
    assert!(!stored.primary_received);
}

#[test]
fn expired_alias_is_routed_to_quarantine() {
    let fixture = Fixture::new();
    fixture.send(
        "old.farm@example.com",
        b"From: sender@example.com\r\nSubject: old\r\n\r\nbody\r\n",
    );

    let envelopes = fixture.delivered();
    let text = String::from_utf8_lossy(&envelopes[0].data);
    assert!(text.contains("X-Wickmail-Route: Quarantine\r\n"), "{text}");

    // Inbound mail never extends the lease.
    let alias = fixture
        .service
        .lock()
        .unwrap()
        .store()
        .get_alias_by_address(&address("old.farm@example.com"))
        .unwrap()
        .unwrap();
    assert_eq!(alias.expires_at, Some(at("2026-01-02T00:00:00Z")));
    assert_eq!(alias.last_inbound_at, Some(at("2026-01-04T00:00:00Z")));
}

#[test]
fn spoofed_wickmail_headers_are_stripped_and_replaced() {
    let fixture = Fixture::new();
    fixture.send(
        "green.farm@example.com",
        b"X-Wickmail-Route: Quarantine\r\n\
X-Wickmail-Alias-ID: 018f9b60-0000-7000-8000-0000000000ff\r\n\
Subject: spoof\r\n\r\nbody\r\n",
    );

    let envelopes = fixture.delivered();
    let text = String::from_utf8_lossy(&envelopes[0].data);
    assert!(text.contains("X-Wickmail-Route: Inbox\r\n"), "{text}");
    assert!(!text.contains("Quarantine"), "{text}");
    assert!(!text.contains("0000000000ff"), "{text}");
}

#[test]
fn spam_wins_over_alias_state() {
    let fixture = Fixture::new();
    fixture.send(
        "old.farm@example.com",
        b"X-Spam: Yes\r\nSubject: spam\r\n\r\nbody\r\n",
    );

    let envelopes = fixture.delivered();
    let text = String::from_utf8_lossy(&envelopes[0].data);
    assert!(text.contains("X-Wickmail-Route: Spam\r\n"), "{text}");
}

#[test]
fn disabled_alias_is_not_rejected_at_delivery() {
    let fixture = Fixture::new();
    fixture.send(
        "off.farm@example.com",
        b"From: sender@example.com\r\nSubject: disabled\r\n\r\nbody\r\n",
    );

    let envelopes = fixture.delivered();
    assert_eq!(envelopes.len(), 1);
    let text = String::from_utf8_lossy(&envelopes[0].data);
    assert!(text.contains("X-Wickmail-Route: Quarantine\r\n"), "{text}");
}

#[test]
fn full_spool_returns_a_temporary_failure() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("wickmail.sqlite")).unwrap();
    store.migrate().unwrap();
    let service = AliasService::new(
        store,
        AliasGenerator::new(),
        Domain::parse("example.com").unwrap(),
        Arc::new(FixedClock::new(at("2026-01-04T00:00:00Z"))),
    );
    let service = Arc::new(Mutex::new(service));
    let policy = Arc::new(RecipientPolicy::new(
        address("user@example.com"),
        service.clone(),
    ));
    let spool = Arc::new(Spool::open(dir.path().join("spool"), 0).unwrap());
    let client = LmtpClient::new(
        LmtpTarget::Unix(dir.path().join("nonexistent.sock")),
        "wickmail",
    );
    let path = MailPath::new(
        policy,
        spool,
        Arc::new(client),
        service,
        address("user@example.com"),
        Arc::new(FixedClock::new(at("2026-01-04T00:00:00Z"))),
    );

    let replies = path.process(Envelope {
        sender: "sender@example.com".to_string(),
        recipients: vec!["user@example.com".to_string()],
        data: b"Subject: hi\r\n\r\nbody\r\n".to_vec(),
    });
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].code, 451);
    // Spool exhaustion raises the alert counter.
    assert_eq!(path.metrics().spool_full, 1);
    assert_eq!(path.metrics().accepted, 0);
}

#[test]
fn policy_accepts_active_and_expired_and_rejects_disabled() {
    let fixture = Fixture::new();
    let policy = {
        let primary = address("user@example.com");
        RecipientPolicy::new(primary, fixture.service.clone())
    };
    assert_eq!(policy.decide("user@example.com"), PolicyDecision::Accept);
    assert_eq!(
        policy.decide("green.farm@example.com"),
        PolicyDecision::Accept
    );
    assert_eq!(
        policy.decide("old.farm@example.com"),
        PolicyDecision::Accept
    );
    assert!(matches!(
        policy.decide("off.farm@example.com"),
        PolicyDecision::Reject(_)
    ));

    let alias = fixture
        .service
        .lock()
        .unwrap()
        .store()
        .get_alias_by_address(&address("green.farm@example.com"))
        .unwrap()
        .unwrap();
    assert_eq!(
        evaluate_state(&alias, at("2026-01-04T00:00:00Z")),
        AliasState::Active
    );
}

#[test]
fn spool_worker_retries_until_dovecot_is_available() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join("wickmail.sqlite")).unwrap();
    store.migrate().unwrap();
    let service = Arc::new(Mutex::new(AliasService::new(
        store,
        AliasGenerator::new(),
        Domain::parse("example.com").unwrap(),
        Arc::new(FixedClock::new(at("2026-01-04T00:00:00Z"))),
    )));
    let policy = Arc::new(RecipientPolicy::new(
        address("user@example.com"),
        service.clone(),
    ));
    let spool = Arc::new(Spool::open(dir.path().join("spool"), 100).unwrap());
    let dovecot_socket = dir.path().join("dovecot.sock");
    let client = LmtpClient::new(LmtpTarget::Unix(dovecot_socket.clone()), "wickmail");
    let path = MailPath::new(
        policy,
        spool.clone(),
        Arc::new(client),
        service,
        address("user@example.com"),
        Arc::new(FixedClock::new(at("2026-01-04T00:00:00Z"))),
    );

    let replies = path.process(Envelope {
        sender: "sender@example.com".to_string(),
        recipients: vec!["user@example.com".to_string()],
        data: b"Subject: retry\r\n\r\nbody\r\n".to_vec(),
    });
    assert_eq!(replies[0].code, 250);
    assert_eq!(spool.stats().unwrap().depth, 1);
    assert_eq!(path.metrics().accepted, 1);

    // The first forward fails because Dovecot is not running yet.
    assert_eq!(path.forward_pending().unwrap(), 0);
    assert_eq!(spool.stats().unwrap().depth, 1);
    let attempts = spool.entries().unwrap()[0].meta.attempts;
    assert_eq!(attempts, 1);
    // The message stays in the spool; the failure is counted, not bounced.
    assert_eq!(path.metrics().forwarding_failures, 1);

    // Start Dovecot and retry: the message is delivered and the spool drains.
    let dovecot = Arc::new(Mutex::new(Vec::new()));
    spawn_lmtp(
        bind_lmtp(&dovecot_socket).unwrap(),
        Arc::new(RecordingDovecot {
            envelopes: dovecot.clone(),
        }),
    );
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(path.forward_pending().unwrap(), 1);
    assert_eq!(spool.stats().unwrap().depth, 0);
    assert_eq!(dovecot.lock().unwrap().len(), 1);
    assert_eq!(path.metrics().delivered, 1);
}

fn envelope(recipient: &str, data: &[u8]) -> Envelope {
    Envelope {
        sender: "sender@example.com".to_string(),
        recipients: vec![recipient.to_string()],
        data: data.to_vec(),
    }
}

#[test]
fn policy_database_outage_at_rcpt_is_temporary_not_unknown() {
    let fixture = Fixture::new();
    fixture
        .service
        .lock()
        .unwrap()
        .store()
        .connection()
        .execute_batch("ALTER TABLE aliases RENAME TO aliases_outage;")
        .unwrap();

    let policy = RecipientPolicy::new(address("user@example.com"), fixture.service.clone());
    let decision = policy.decide("green.farm@example.com");
    assert!(
        matches!(decision, PolicyDecision::Temporary(_)),
        "{decision:?}"
    );
    assert!(
        !matches!(&decision, PolicyDecision::Reject(reason) if reason == "unknown recipient"),
        "an internal failure was reported as an unknown recipient"
    );
}

#[test]
fn policy_database_outage_at_delivery_is_temporary_and_not_bounced() {
    let fixture = Fixture::new();
    fixture
        .service
        .lock()
        .unwrap()
        .store()
        .connection()
        .execute_batch("ALTER TABLE aliases RENAME TO aliases_outage;")
        .unwrap();

    let replies = fixture.path.process(envelope(
        "green.farm@example.com",
        b"Subject: x\r\n\r\nbody\r\n",
    ));
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].code, 451, "{replies:?}");
    // Nothing was accepted, so nothing is forwarded or bounced.
    assert!(fixture.delivered().is_empty());
    assert_eq!(fixture.path.spool().stats().unwrap().depth, 0);
    assert_eq!(fixture.path.metrics().policy_failures, 1);
}

#[test]
fn an_unavailable_spool_returns_temporary_before_acceptance() {
    let fixture = Fixture::new();
    std::fs::remove_dir_all(fixture.path.spool().dir()).unwrap();

    let replies = fixture.path.process(envelope(
        "green.farm@example.com",
        b"Subject: x\r\n\r\nbody\r\n",
    ));
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].code, 451, "{replies:?}");
    assert!(fixture.delivered().is_empty());
    assert_eq!(fixture.path.metrics().spool_unavailable, 1);
    assert_eq!(fixture.path.metrics().spool_full, 0);
}

#[test]
fn a_corrupt_spool_entry_does_not_block_later_deliveries() {
    let fixture = Fixture::new();
    assert_eq!(
        fixture.path.process(envelope(
            "green.farm@example.com",
            b"Subject: one\r\n\r\nbody\r\n"
        ))[0]
            .code,
        250
    );
    assert_eq!(
        fixture.path.process(envelope(
            "green.farm@example.com",
            b"Subject: two\r\n\r\nbody\r\n"
        ))[0]
            .code,
        250
    );

    let entries = fixture.path.spool().entries().unwrap();
    assert_eq!(entries.len(), 2);
    let corrupt = entries
        .iter()
        .find(|entry| entry.meta.subject == "one")
        .unwrap()
        .id;
    std::fs::remove_file(fixture.path.spool().dir().join(format!("{corrupt}.eml"))).unwrap();

    // The unreadable entry is skipped; the entry behind it still delivers.
    assert_eq!(fixture.path.forward_pending().unwrap(), 1);
    let delivered = fixture.delivered();
    assert_eq!(delivered.len(), 1);
    assert!(
        String::from_utf8_lossy(&delivered[0].data).contains("Subject: two"),
        "the later entry should have been delivered"
    );
    assert_eq!(fixture.path.spool().entries().unwrap().len(), 1);
    assert_eq!(fixture.path.metrics().forwarding_failures, 1);
}

#[test]
fn multiple_alias_provenance_records_every_receiving_alias() {
    let fixture = Fixture::new();
    let replies = fixture.path.process(Envelope {
        sender: "sender@example.com".to_string(),
        recipients: vec![
            "user@example.com".to_string(),
            "green.farm@example.com".to_string(),
            "blue.sky@example.com".to_string(),
        ],
        data: b"From: sender@example.com\r\nSubject: both\r\n\r\nbody\r\n".to_vec(),
    });
    assert_eq!(replies.len(), 3);
    assert!(replies.iter().all(|reply| reply.code == 250), "{replies:?}");
    assert_eq!(fixture.path.forward_pending().unwrap(), 1);

    let delivered = fixture.delivered();
    assert_eq!(delivered.len(), 1);
    let text = String::from_utf8_lossy(&delivered[0].data).to_string();
    assert!(text.contains("X-Wickmail-Route: Inbox\r\n"), "{text}");
    let alias_headers = text
        .lines()
        .filter(|line| line.starts_with("X-Wickmail-Alias-ID:"))
        .count();
    assert_eq!(alias_headers, 2, "{text}");

    let message_id = header(&text, "X-Wickmail-Message-ID").unwrap();
    let stored = fixture
        .service
        .lock()
        .unwrap()
        .store()
        .get_message(message_id.parse().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(stored.alias_ids.len(), 2);
    assert!(stored.primary_received);
}

#[test]
fn primary_only_delivery_uses_the_primary_identity() {
    let fixture = Fixture::new();
    let replies = fixture.path.process(envelope(
        "user@example.com",
        b"Subject: direct\r\n\r\nbody\r\n",
    ));
    assert_eq!(replies[0].code, 250);
    assert_eq!(fixture.path.forward_pending().unwrap(), 1);

    let delivered = fixture.delivered();
    let text = String::from_utf8_lossy(&delivered[0].data).to_string();
    assert!(text.contains("X-Wickmail-Route: Inbox\r\n"), "{text}");
    assert!(!text.contains("X-Wickmail-Alias-ID:"), "{text}");

    let message_id = header(&text, "X-Wickmail-Message-ID").unwrap();
    let stored = fixture
        .service
        .lock()
        .unwrap()
        .store()
        .get_message(message_id.parse().unwrap())
        .unwrap()
        .unwrap();
    assert!(stored.alias_ids.is_empty());
    assert!(stored.primary_received);
}

#[test]
fn lookup_is_case_insensitive_and_plus_tags_do_not_match() {
    let fixture = Fixture::new();
    let policy = RecipientPolicy::new(address("user@example.com"), fixture.service.clone());
    assert_eq!(
        policy.decide("GREEN.FARM@Example.COM"),
        PolicyDecision::Accept
    );
    assert!(matches!(
        policy.decide("green.farm+orders@example.com"),
        PolicyDecision::Reject(_)
    ));

    let replies = fixture.path.process(envelope(
        "GREEN.FARM@Example.COM",
        b"Subject: case\r\n\r\nbody\r\n",
    ));
    assert_eq!(replies[0].code, 250);
    assert_eq!(fixture.path.forward_pending().unwrap(), 1);
    let text = String::from_utf8_lossy(&fixture.delivered()[0].data).to_string();
    assert!(text.contains("X-Wickmail-Route: Inbox\r\n"), "{text}");
    assert!(text.contains("X-Wickmail-Alias-ID:"), "{text}");
}

#[test]
fn a_spoofed_inbound_mail_from_does_not_renew_the_alias() {
    let fixture = Fixture::new();
    let before = fixture
        .service
        .lock()
        .unwrap()
        .store()
        .get_alias_by_address(&address("green.farm@example.com"))
        .unwrap()
        .unwrap();

    // The envelope sender is the alias address itself; inbound mail records
    // activity but never extends the lease.
    fixture.send_from(
        "green.farm@example.com",
        "green.farm@example.com",
        b"From: attacker@example.net\r\nSubject: spoof\r\n\r\nbody\r\n",
    );

    let after = fixture
        .service
        .lock()
        .unwrap()
        .store()
        .get_alias_by_address(&address("green.farm@example.com"))
        .unwrap()
        .unwrap();
    assert_eq!(after.expires_at, before.expires_at);
    assert_eq!(after.last_inbound_at, Some(at("2026-01-04T00:00:00Z")));
}

fn header<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    text.lines()
        .find(|line| {
            line.split_once(':')
                .is_some_and(|(key, _)| key.eq_ignore_ascii_case(name))
        })
        .and_then(|line| line.split_once(':').map(|(_, value)| value.trim()))
}
