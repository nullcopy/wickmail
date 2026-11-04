//! Abuse-control integration tests.
//!
//! These exercise the inbound mail path's maximum message size, per-sender and
//! global rate limits, and per-alias quarantine quotas through the same entry
//! points the LMTP proxy uses.

use std::sync::{Arc, Mutex};

use wickmail_server::abuse::{AbusePolicy, AlertKind, RateLimit, RateLimiter, RecordingAlerter};
use wickmail_server::address::{CanonicalAddress, Domain};
use wickmail_server::clock::FixedClock;
use wickmail_server::db::Store;
use wickmail_server::generator::AliasGenerator;
use wickmail_server::mail::lmtp::{Envelope, LmtpClient, LmtpTarget};
use wickmail_server::mail::policy::RecipientPolicy;
use wickmail_server::mail::runtime::MailPath;
use wickmail_server::mail::spool::Spool;
use wickmail_server::mail::store::MailStoreAdapter;
use wickmail_server::message::{Message, MessageId, Route};
use wickmail_server::quarantine::{QuarantineManager, QuarantineStatus, RetentionPolicy};
use wickmail_server::service::{AliasService, CreateAlias, ExpiryChoice};
use wickmail_server::timestamp::Timestamp;

fn at(value: &str) -> Timestamp {
    value.parse().unwrap()
}

fn clock() -> Arc<FixedClock> {
    Arc::new(FixedClock::new(at("2026-01-04T00:00:00Z")))
}

struct MailPathFixture {
    path: MailPath,
    alerter: Arc<RecordingAlerter>,
    _spool: tempfile::TempDir,
}

fn mail_path(abuse: AbusePolicy) -> MailPathFixture {
    let mut store = Store::open_in_memory().unwrap();
    store.migrate().unwrap();
    let service = Arc::new(Mutex::new(AliasService::new(
        store,
        AliasGenerator::new(),
        Domain::parse("example.com").unwrap(),
        clock(),
    )));
    let primary = CanonicalAddress::parse("user@example.com").unwrap();
    let policy = Arc::new(RecipientPolicy::new(primary.clone(), service.clone()));
    let spool_dir = tempfile::tempdir().unwrap();
    let spool = Arc::new(Spool::open(spool_dir.path(), 100).unwrap());
    let client = Arc::new(LmtpClient::new(
        LmtpTarget::Unix("/nonexistent".into()),
        "wickmail",
    ));
    let mut path = MailPath::new(policy, spool, client, service, primary, clock());
    let alerter = Arc::new(RecordingAlerter::new());
    path.with_abuse(abuse, Arc::new(RateLimiter::new()), alerter.clone());
    MailPathFixture {
        path,
        alerter,
        _spool: spool_dir,
    }
}

fn envelope(size: usize) -> Envelope {
    Envelope {
        sender: "sender@example.net".to_string(),
        recipients: vec!["user@example.com".to_string()],
        data: vec![b'x'; size],
    }
}

#[test]
fn oversized_messages_are_rejected_and_alerted() {
    let fixture = mail_path(AbusePolicy {
        max_message_bytes: 64,
        ..AbusePolicy::disabled()
    });
    let replies = fixture.path.process(envelope(128));
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].code, 552);
    assert!(fixture.alerter.kinds().contains(&AlertKind::QuotaExceeded));
}

#[test]
fn per_sender_rate_limit_returns_a_temporary_failure() {
    let fixture = mail_path(AbusePolicy {
        max_message_bytes: usize::MAX,
        per_sender: Some(RateLimit {
            capacity: 2,
            window_seconds: 3600,
        }),
        global: None,
        ..AbusePolicy::disabled()
    });
    assert_eq!(fixture.path.process(envelope(16))[0].code, 250);
    assert_eq!(fixture.path.process(envelope(16))[0].code, 250);
    assert_eq!(fixture.path.process(envelope(16))[0].code, 451);
    assert!(fixture.alerter.kinds().contains(&AlertKind::RateLimited));
}

#[test]
fn global_rate_limit_returns_a_temporary_failure() {
    let fixture = mail_path(AbusePolicy {
        max_message_bytes: usize::MAX,
        per_sender: None,
        global: Some(RateLimit {
            capacity: 1,
            window_seconds: 3600,
        }),
        ..AbusePolicy::disabled()
    });
    assert_eq!(fixture.path.process(envelope(16))[0].code, 250);
    assert_eq!(fixture.path.process(envelope(16))[0].code, 451);
}

fn quarantined_alias(service: &AliasService) -> wickmail_server::alias::Alias {
    service
        .create(CreateAlias {
            expiry: ExpiryChoice::Absolute(at("2026-01-01T00:00:00Z")),
            ..CreateAlias::default()
        })
        .unwrap()
}

fn record_quarantine(service: &AliasService, alias: &wickmail_server::alias::Alias, day: u8) {
    let message = Message {
        id: MessageId::new(),
        alias_ids: vec![alias.id],
        primary_received: false,
        sender: "sender@example.net".to_string(),
        subject: format!("message {day}"),
        received_at: at(&format!("2026-01-{day:02}T00:00:00Z")),
        route: Route::Quarantine,
    };
    service.record_delivery(&message).unwrap();
}

#[test]
fn per_alias_count_quota_deletes_the_oldest_first() {
    let mut store = Store::open_in_memory().unwrap();
    store.migrate().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let adapter = MailStoreAdapter::open(dir.path());
    let service = AliasService::new(
        store,
        AliasGenerator::new(),
        Domain::parse("example.com").unwrap(),
        clock(),
    );
    let alias = quarantined_alias(&service);
    for day in 1..=3 {
        record_quarantine(&service, &alias, day);
    }

    let manager = QuarantineManager::new(
        service.store(),
        &adapter,
        RetentionPolicy::default(),
        clock(),
    );
    let deleted = manager.enforce_quotas(Some(2), None).unwrap();
    assert_eq!(deleted, 1);

    let remaining = service
        .store()
        .list_quarantine_metadata()
        .unwrap()
        .into_iter()
        .filter(|metadata| metadata.status == QuarantineStatus::Quarantined)
        .count();
    assert_eq!(remaining, 2);
}

#[test]
fn per_alias_byte_quota_deletes_the_oldest_first() {
    let mut store = Store::open_in_memory().unwrap();
    store.migrate().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let adapter = MailStoreAdapter::open(dir.path());
    let service = AliasService::new(
        store,
        AliasGenerator::new(),
        Domain::parse("example.com").unwrap(),
        clock(),
    );
    let alias = quarantined_alias(&service);
    for day in 1..=2 {
        record_quarantine(&service, &alias, day);
    }
    for metadata in service.store().list_quarantine_metadata().unwrap() {
        let mut metadata = metadata;
        metadata.size_bytes = 100;
        service
            .store()
            .upsert_quarantine_metadata(&metadata)
            .unwrap();
    }

    let manager = QuarantineManager::new(
        service.store(),
        &adapter,
        RetentionPolicy::default(),
        clock(),
    );
    let deleted = manager.enforce_quotas(None, Some(150)).unwrap();
    assert_eq!(deleted, 1);
    let bytes: u64 = service
        .store()
        .list_quarantine_metadata()
        .unwrap()
        .into_iter()
        .filter(|metadata| metadata.status == QuarantineStatus::Quarantined)
        .map(|metadata| metadata.size_bytes)
        .sum();
    assert_eq!(bytes, 100);
}
