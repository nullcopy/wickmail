//! Crash-point tests for quarantine recovery, reconciliation, and retention.
//!
//! Each test injects a fault at a state-machine boundary to simulate a crash,
//! then asserts the on-disk state and that reconciliation repairs it. The mail
//! store is a real Maildir tree on disk and the metadata store is SQLite, so
//! the tests exercise the same two-store disagreement the design describes.

use std::fs;
use std::sync::Arc;

use wickmail_server::address::CanonicalAddress;
use wickmail_server::alias::{Alias, AliasId, DEFAULT_LEASE_SECONDS};
use wickmail_server::clock::{FixedClock, SharedClock};
use wickmail_server::db::Store;
use wickmail_server::mail::store::{INBOX_MAILBOX, MailStoreAdapter, QUARANTINE_MAILBOX};
use wickmail_server::message::{Message, MessageId, Route};
use wickmail_server::quarantine::{
    DeleteReason, FaultInjector, FaultPoint, QuarantineError, QuarantineKind, QuarantineManager,
    QuarantineMetadata, QuarantineStatus, RetentionLimits, RetentionPolicy, mailbox_for,
};
use wickmail_server::timestamp::Timestamp;

fn at(value: &str) -> Timestamp {
    value.parse().unwrap()
}

/// A fault injector that aborts at exactly one boundary.
struct CrashAt(FaultPoint);

impl FaultInjector for CrashAt {
    fn check(&self, point: FaultPoint) -> Result<(), QuarantineError> {
        if point == self.0 {
            Err(QuarantineError::Injected(point))
        } else {
            Ok(())
        }
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    store: Store,
    adapter: MailStoreAdapter,
    clock: SharedClock,
    alias_id: AliasId,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let maildir = dir.path().join("Maildir");
        let quarantine = dir.path().join("quarantine/.Expired");
        for path in [
            maildir.join("cur"),
            maildir.join("new"),
            quarantine.join("cur"),
            quarantine.join("new"),
        ] {
            fs::create_dir_all(path).unwrap();
        }

        let mut store = Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        let alias = Alias {
            id: AliasId::new(),
            address: CanonicalAddress::parse("old.farm@example.com").unwrap(),
            label: None,
            purpose: None,
            created_at: at("2026-01-01T00:00:00Z"),
            expires_at: Some(at("2026-01-02T00:00:00Z")),
            disabled_at: None,
            lease_duration_seconds: DEFAULT_LEASE_SECONDS,
            renew_on_outbound: true,
            last_inbound_at: None,
            last_user_activity_at: None,
            policy_version: 0,
        };
        store.insert_alias(&alias).unwrap();

        Self {
            _dir: dir,
            store,
            adapter: MailStoreAdapter::with_quarantine(&maildir, &quarantine),
            clock: Arc::new(FixedClock::new(at("2026-01-01T00:00:00Z"))),
            alias_id: alias.id,
        }
    }

    fn manager(&self) -> QuarantineManager<'_> {
        QuarantineManager::new(
            &self.store,
            &self.adapter,
            RetentionPolicy::default(),
            self.clock.clone(),
        )
    }

    fn manager_at(&self, now: &str) -> QuarantineManager<'_> {
        QuarantineManager::new(
            &self.store,
            &self.adapter,
            RetentionPolicy::default(),
            Arc::new(FixedClock::new(at(now))),
        )
    }

    fn manager_with(&self, policy: RetentionPolicy, now: &str) -> QuarantineManager<'_> {
        QuarantineManager::new(
            &self.store,
            &self.adapter,
            policy,
            Arc::new(FixedClock::new(at(now))),
        )
    }

    /// Records a quarantined or spam message and places its body in the store.
    fn deliver(
        &self,
        kind: QuarantineKind,
        id: MessageId,
        received_at: &str,
    ) -> QuarantineMetadata {
        let route = match kind {
            QuarantineKind::Lease => Route::Quarantine,
            QuarantineKind::Spam => Route::Spam,
        };
        let message = Message {
            id,
            alias_ids: vec![self.alias_id],
            primary_received: false,
            sender: "sender@example.net".to_string(),
            subject: "hello".to_string(),
            received_at: at(received_at),
            route,
        };
        self.store.record_inbound_delivery(&message).unwrap();
        self.manager().record(&message).unwrap();
        self.write(mailbox_for(kind), id, "Subject: hello\r\n\r\nbody\r\n");
        self.store.get_quarantine_metadata(id).unwrap().unwrap()
    }

    fn write(&self, mailbox: &str, id: MessageId, body: &str) {
        let dir = self.adapter.mailbox_dir(mailbox).join("cur");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("{id}.eml")),
            format!("X-Wickmail-Message-ID: {id}\r\n{body}"),
        )
        .unwrap();
    }

    fn status(&self, id: MessageId) -> QuarantineStatus {
        self.store
            .get_quarantine_metadata(id)
            .unwrap()
            .unwrap()
            .status
    }

    fn in_inbox(&self, id: MessageId) -> bool {
        self.adapter.contains(INBOX_MAILBOX, id).unwrap()
    }

    fn in_quarantine(&self, id: MessageId) -> bool {
        self.adapter.contains(QUARANTINE_MAILBOX, id).unwrap()
    }

    fn inbox_count(&self) -> usize {
        self.adapter.list(INBOX_MAILBOX).unwrap().len()
    }
}

#[test]
fn recovery_moves_the_message_without_duplicating() {
    let fixture = Fixture::new();
    let id = MessageId::new();
    fixture.deliver(QuarantineKind::Lease, id, "2026-01-01T00:00:00Z");

    let recovered = fixture.manager().recover(id).unwrap();
    assert_eq!(recovered.status, QuarantineStatus::Recovered);
    assert!(fixture.in_inbox(id));
    assert!(!fixture.in_quarantine(id));
    assert_eq!(fixture.inbox_count(), 1);

    // Recovery is idempotent and never duplicates the message.
    let again = fixture.manager().recover(id).unwrap();
    assert_eq!(again.status, QuarantineStatus::Recovered);
    assert_eq!(fixture.inbox_count(), 1);
}

#[test]
fn recovery_records_an_idempotency_key() {
    let fixture = Fixture::new();
    let id = MessageId::new();
    fixture.deliver(QuarantineKind::Lease, id, "2026-01-01T00:00:00Z");

    let error = fixture
        .manager()
        .recover_with(id, &CrashAt(FaultPoint::BeforeInboxCopy))
        .unwrap_err();
    assert!(matches!(error, QuarantineError::Injected(_)));
    let metadata = fixture.store.get_quarantine_metadata(id).unwrap().unwrap();
    assert_eq!(metadata.status, QuarantineStatus::Recovering);
    assert!(metadata.idempotency_key.is_some());
}

#[test]
fn crash_before_the_inbox_copy_returns_to_quarantined() {
    let fixture = Fixture::new();
    let id = MessageId::new();
    fixture.deliver(QuarantineKind::Lease, id, "2026-01-01T00:00:00Z");

    fixture
        .manager()
        .recover_with(id, &CrashAt(FaultPoint::BeforeInboxCopy))
        .unwrap_err();
    assert_eq!(fixture.status(id), QuarantineStatus::Recovering);
    assert!(!fixture.in_inbox(id));
    assert!(fixture.in_quarantine(id));

    let report = fixture.manager().reconcile().unwrap();
    assert_eq!(report.restored_to_quarantine, 1);
    assert_eq!(fixture.status(id), QuarantineStatus::Quarantined);
    assert!(fixture.in_quarantine(id));

    // The recovered message is deliverable after reconciliation.
    fixture.manager().recover(id).unwrap();
    assert_eq!(fixture.status(id), QuarantineStatus::Recovered);
    assert_eq!(fixture.inbox_count(), 1);
}

#[test]
fn crash_between_copy_and_delete_keeps_the_inbox_copy() {
    let fixture = Fixture::new();
    let id = MessageId::new();
    fixture.deliver(QuarantineKind::Lease, id, "2026-01-01T00:00:00Z");

    fixture
        .manager()
        .recover_with(id, &CrashAt(FaultPoint::BeforeQuarantineDelete))
        .unwrap_err();
    assert_eq!(fixture.status(id), QuarantineStatus::Recovering);
    assert!(fixture.in_inbox(id));
    assert!(fixture.in_quarantine(id));
    assert_eq!(fixture.inbox_count(), 1);

    let report = fixture.manager().reconcile().unwrap();
    assert_eq!(report.removed_duplicate_copies, 1);
    assert_eq!(report.completed_recoveries, 1);
    assert_eq!(fixture.status(id), QuarantineStatus::Recovered);
    assert!(fixture.in_inbox(id));
    assert!(!fixture.in_quarantine(id));
    assert_eq!(fixture.inbox_count(), 1);
}

#[test]
fn crash_after_delete_before_mark_completes_on_reconcile() {
    let fixture = Fixture::new();
    let id = MessageId::new();
    fixture.deliver(QuarantineKind::Lease, id, "2026-01-01T00:00:00Z");

    fixture
        .manager()
        .recover_with(id, &CrashAt(FaultPoint::BeforeMarkRecovered))
        .unwrap_err();
    assert_eq!(fixture.status(id), QuarantineStatus::Recovering);
    assert!(fixture.in_inbox(id));
    assert!(!fixture.in_quarantine(id));

    let report = fixture.manager().reconcile().unwrap();
    assert_eq!(report.completed_recoveries, 1);
    assert_eq!(fixture.status(id), QuarantineStatus::Recovered);
    assert_eq!(fixture.inbox_count(), 1);
}

#[test]
fn reconcile_prefers_the_inbox_copy_when_both_exist() {
    let fixture = Fixture::new();
    let id = MessageId::new();
    fixture.deliver(QuarantineKind::Lease, id, "2026-01-01T00:00:00Z");
    // A crash-free copy left a second copy without recording recovery.
    fixture
        .adapter
        .copy_to(QUARANTINE_MAILBOX, INBOX_MAILBOX, id)
        .unwrap();
    assert_eq!(fixture.status(id), QuarantineStatus::Quarantined);

    let report = fixture.manager().reconcile().unwrap();
    assert_eq!(report.removed_duplicate_copies, 1);
    assert_eq!(fixture.status(id), QuarantineStatus::Recovered);
    assert_eq!(fixture.inbox_count(), 1);
    assert!(!fixture.in_quarantine(id));
}

#[test]
fn reconcile_rebuilds_metadata_from_the_mail_store() {
    let fixture = Fixture::new();
    let id = MessageId::new();
    // The body is in quarantine but the database has no metadata for it.
    fixture.write(QUARANTINE_MAILBOX, id, "Subject: orphan\r\n\r\nbody\r\n");
    assert!(fixture.store.get_quarantine_metadata(id).unwrap().is_none());

    let report = fixture.manager().reconcile().unwrap();
    assert_eq!(report.metadata_rebuilt, 1);
    let metadata = fixture.store.get_quarantine_metadata(id).unwrap().unwrap();
    assert_eq!(metadata.kind, QuarantineKind::Lease);
    assert_eq!(metadata.status, QuarantineStatus::Quarantined);
    assert_eq!(
        metadata.locator.as_ref().unwrap().mailbox,
        QUARANTINE_MAILBOX
    );
}

#[test]
fn locator_cache_is_rebuilt_and_never_identity() {
    let fixture = Fixture::new();
    let id = MessageId::new();
    fixture.deliver(QuarantineKind::Lease, id, "2026-01-01T00:00:00Z");

    // Replace the body file with one that carries Dovecot UID metadata.
    let quarantine = fixture.adapter.mailbox_dir(QUARANTINE_MAILBOX);
    fs::write(quarantine.join("dovecot-uidvalidity"), "1700000000\n").unwrap();
    fs::remove_file(quarantine.join("cur").join(format!("{id}.eml"))).unwrap();
    fs::write(
        quarantine.join("cur/1700000000.M1P1.host,U=9:2,S"),
        format!("X-Wickmail-Message-ID: {id}\r\nSubject: hello\r\n\r\nbody\r\n"),
    )
    .unwrap();

    fixture.manager().reconcile().unwrap();
    let metadata = fixture.store.get_quarantine_metadata(id).unwrap().unwrap();
    let locator = metadata.locator.unwrap();
    assert_eq!(locator.mailbox, QUARANTINE_MAILBOX);
    assert_eq!(locator.uidvalidity, 1_700_000_000);
    assert_eq!(locator.uid, 9);

    // A stale UIDVALIDITY and UID do not affect identity resolution.
    let stale = wickmail_server::mail::store::MailboxLocator {
        mailbox: QUARANTINE_MAILBOX.to_string(),
        uidvalidity: 1,
        uid: 1,
    };
    assert!(
        fixture
            .adapter
            .read_with_locator(id, &stale)
            .unwrap()
            .is_some()
    );
}

#[test]
fn retention_crash_before_body_delete_repairs() {
    let fixture = Fixture::new();
    let id = MessageId::new();
    fixture.deliver(QuarantineKind::Lease, id, "2026-01-01T00:00:00Z");

    let error = fixture
        .manager_at("2026-03-01T00:00:00Z")
        .retention_sweep_with(&CrashAt(FaultPoint::BeforeBodyDelete))
        .unwrap_err();
    assert!(matches!(error, QuarantineError::Injected(_)));
    assert_eq!(fixture.status(id), QuarantineStatus::Deleting);
    assert!(fixture.in_quarantine(id));

    let report = fixture
        .manager_at("2026-03-01T00:00:00Z")
        .reconcile()
        .unwrap();
    assert_eq!(report.completed_deletions, 1);
    assert_eq!(fixture.status(id), QuarantineStatus::Deleted);
    assert!(!fixture.in_quarantine(id));
}

#[test]
fn retention_crash_after_body_delete_repairs() {
    let fixture = Fixture::new();
    let id = MessageId::new();
    fixture.deliver(QuarantineKind::Lease, id, "2026-01-01T00:00:00Z");

    fixture
        .manager_at("2026-03-01T00:00:00Z")
        .retention_sweep_with(&CrashAt(FaultPoint::AfterBodyDelete))
        .unwrap_err();
    assert_eq!(fixture.status(id), QuarantineStatus::Deleting);
    assert!(!fixture.in_quarantine(id));

    let report = fixture
        .manager_at("2026-03-01T00:00:00Z")
        .reconcile()
        .unwrap();
    assert_eq!(report.completed_deletions, 1);
    assert_eq!(fixture.status(id), QuarantineStatus::Deleted);
}

#[test]
fn retention_skips_recovery_in_flight() {
    let fixture = Fixture::new();
    let id = MessageId::new();
    fixture.deliver(QuarantineKind::Lease, id, "2026-01-01T00:00:00Z");

    // A crash before the inbox copy leaves the message recovering, and the
    // retention window has long elapsed.
    fixture
        .manager()
        .recover_with(id, &CrashAt(FaultPoint::BeforeInboxCopy))
        .unwrap_err();
    assert_eq!(fixture.status(id), QuarantineStatus::Recovering);

    let report = fixture
        .manager_at("2026-03-01T00:00:00Z")
        .retention_sweep()
        .unwrap();
    assert_eq!(report.deleted, 0);
    assert_eq!(fixture.status(id), QuarantineStatus::Recovering);
    assert!(fixture.in_quarantine(id));
}

#[test]
fn retention_never_deletes_deleting_metadata() {
    let fixture = Fixture::new();
    let id = MessageId::new();
    fixture.deliver(QuarantineKind::Lease, id, "2026-01-01T00:00:00Z");

    fixture
        .manager_at("2026-03-01T00:00:00Z")
        .delete_with(
            id,
            DeleteReason::UserRequest,
            &CrashAt(FaultPoint::BeforeBodyDelete),
        )
        .unwrap_err();
    assert_eq!(fixture.status(id), QuarantineStatus::Deleting);

    // Retention sees the row but skips it because deletion is in progress.
    fixture
        .manager_at("2026-03-01T00:00:00Z")
        .retention_sweep()
        .unwrap();
    // Reconciliation is what completes the interrupted deletion.
    fixture
        .manager_at("2026-03-01T00:00:00Z")
        .reconcile()
        .unwrap();
    assert_eq!(fixture.status(id), QuarantineStatus::Deleted);
}

#[test]
fn spam_and_lease_retention_windows_are_separate() {
    let fixture = Fixture::new();
    let lease = MessageId::new();
    let spam = MessageId::new();
    fixture.deliver(QuarantineKind::Lease, lease, "2026-01-01T00:00:00Z");
    fixture.deliver(QuarantineKind::Spam, spam, "2026-01-01T00:00:00Z");

    // 20 days on, spam (14 days) is expired but lease (30 days) is not.
    let report = fixture
        .manager_at("2026-01-21T00:00:00Z")
        .retention_sweep()
        .unwrap();
    assert_eq!(report.deleted, 1);
    assert_eq!(fixture.status(spam), QuarantineStatus::Deleted);
    assert_eq!(fixture.status(lease), QuarantineStatus::Quarantined);

    // 31 days on, the lease is expired too.
    let report = fixture
        .manager_at("2026-02-01T00:00:00Z")
        .retention_sweep()
        .unwrap();
    assert_eq!(report.deleted, 1);
    assert_eq!(fixture.status(lease), QuarantineStatus::Deleted);
}

#[test]
fn quota_deletes_the_oldest_eligible_first() {
    let fixture = Fixture::new();
    let policy = RetentionPolicy {
        lease: RetentionLimits::new(wickmail_server::quarantine::LEASE_QUARANTINE_RETENTION)
            .with_count_quota(2),
        ..RetentionPolicy::default()
    };
    let ids: Vec<MessageId> = (0..4).map(|_| MessageId::new()).collect();
    for (index, id) in ids.iter().enumerate() {
        let received = format!("2026-01-0{}T00:00:00Z", index + 1);
        fixture.deliver(QuarantineKind::Lease, *id, &received);
    }

    let report = fixture
        .manager_with(policy, "2026-01-05T00:00:00Z")
        .retention_sweep()
        .unwrap();
    assert_eq!(report.deleted, 2);
    // The two oldest are gone; the two newest remain.
    assert_eq!(fixture.status(ids[0]), QuarantineStatus::Deleted);
    assert_eq!(fixture.status(ids[1]), QuarantineStatus::Deleted);
    assert_eq!(fixture.status(ids[2]), QuarantineStatus::Quarantined);
    assert_eq!(fixture.status(ids[3]), QuarantineStatus::Quarantined);
}

#[test]
fn metadata_is_purged_after_the_grace_period() {
    let fixture = Fixture::new();
    let id = MessageId::new();
    fixture.deliver(QuarantineKind::Lease, id, "2026-01-01T00:00:00Z");

    fixture
        .manager_at("2026-01-05T00:00:00Z")
        .delete(id, DeleteReason::UserRequest)
        .unwrap();
    assert_eq!(fixture.status(id), QuarantineStatus::Deleted);

    // Within the grace period the metadata row survives.
    fixture
        .manager_at("2026-01-08T00:00:00Z")
        .retention_sweep()
        .unwrap();
    assert!(fixture.store.get_quarantine_metadata(id).unwrap().is_some());

    // Past the grace period it is purged.
    fixture
        .manager_at("2026-02-01T00:00:00Z")
        .retention_sweep()
        .unwrap();
    assert!(fixture.store.get_quarantine_metadata(id).unwrap().is_none());
}

#[test]
fn recovery_is_blocked_while_deletion_is_in_progress() {
    let fixture = Fixture::new();
    let id = MessageId::new();
    fixture.deliver(QuarantineKind::Lease, id, "2026-01-01T00:00:00Z");

    fixture
        .manager()
        .delete_with(
            id,
            DeleteReason::UserRequest,
            &CrashAt(FaultPoint::BeforeBodyDelete),
        )
        .unwrap_err();
    assert_eq!(fixture.status(id), QuarantineStatus::Deleting);

    let error = fixture.manager().recover(id).unwrap_err();
    assert!(matches!(error, QuarantineError::RecoveryBlocked(_)));
}
