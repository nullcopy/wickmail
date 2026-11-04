//! Quarantine metadata, crash-safe recovery, reconciliation, and retention.
//!
//! The mail store is authoritative for quarantine membership; the database
//! holds reconciled metadata and a rebuildable locator cache. Message identity
//! is always the `X-Wickmail-Message-ID` header; `(mailbox, UIDVALIDITY, UID)`
//! is a hint and never establishes identity. See
//! [ADR 0007](../../docs/decisions/0007-quarantine-source-of-truth.md).
//!
//! Recovery and deletion are ordered state machines that persist intent before
//! each destructive step, so a crash at any point leaves a state that
//! [`QuarantineManager::reconcile`] can repair.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use time::Duration;
use uuid::Uuid;

use crate::alias::AliasId;
use crate::clock::SharedClock;
use crate::db::{Store, StoreError};
use crate::mail::headers::MessageParts;
use crate::mail::store::{
    AdapterError, INBOX_MAILBOX, MailStoreAdapter, MessageSummary, QUARANTINE_MAILBOX, SPAM_MAILBOX,
};
use crate::message::{Message, MessageId, Route};
use crate::timestamp::Timestamp;

/// Default retention for lease-based quarantine: 30 days.
pub const LEASE_QUARANTINE_RETENTION: Duration = Duration::days(30);

/// Default retention for spam: 14 days, configured separately from quarantine.
pub const SPAM_RETENTION: Duration = Duration::days(14);

/// How long deleted metadata is kept before it is purged.
pub const METADATA_PURGE_GRACE: Duration = Duration::days(7);

/// Lifecycle status of a quarantined message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuarantineStatus {
    /// Held in quarantine and recoverable.
    Quarantined,
    /// Recovery has started and the idempotency key is recorded.
    Recovering,
    /// The message now lives in the inbox.
    Recovered,
    /// Deletion has started; recovery is blocked.
    Deleting,
    /// The body is gone and metadata awaits the purge grace period.
    Deleted,
}

/// Which lifecycle a quarantined message belongs to.
///
/// Lease quarantine and spam have separate retention windows and mailboxes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuarantineKind {
    /// Mail held for an expired or disabled alias.
    Lease,
    /// Mail classified as spam.
    Spam,
}

/// Why a message was deleted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeleteReason {
    /// An explicit user deletion.
    UserRequest,
    /// The retention window elapsed.
    Retention,
    /// A count or byte quota was exceeded.
    Quota,
    /// The body was already gone.
    MissingBody,
    /// Reconciliation repaired a half-completed deletion.
    Reconciliation,
}

impl DeleteReason {
    /// The stable string stored with the metadata.
    pub fn as_str(self) -> &'static str {
        match self {
            DeleteReason::UserRequest => "user_request",
            DeleteReason::Retention => "retention",
            DeleteReason::Quota => "quota",
            DeleteReason::MissingBody => "missing_body",
            DeleteReason::Reconciliation => "reconciliation",
        }
    }
}

/// Reconciled metadata for one quarantined message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineMetadata {
    /// Stable message identity.
    pub message_id: MessageId,
    /// Lease quarantine or spam.
    pub kind: QuarantineKind,
    /// Current lifecycle status.
    pub status: QuarantineStatus,
    /// Aliases that received the message.
    pub alias_ids: Vec<AliasId>,
    /// Envelope sender.
    pub sender: String,
    /// Subject line, retained only for the retention window.
    pub subject: String,
    /// When the message was accepted.
    pub received_at: Timestamp,
    /// When the retention window ends.
    pub quarantine_expires_at: Timestamp,
    /// Rebuildable locator cache; never identity.
    pub locator: Option<crate::mail::store::MailboxLocator>,
    /// Size of the stored body in bytes, for byte quotas.
    pub size_bytes: u64,
    /// Idempotency key recorded when recovery starts.
    pub idempotency_key: Option<String>,
    /// Why the message was deleted.
    pub delete_reason: Option<String>,
    /// When the metadata row was created.
    pub created_at: Timestamp,
    /// When the metadata row was last updated.
    pub updated_at: Timestamp,
    /// When the message was recovered.
    pub recovered_at: Option<Timestamp>,
    /// When the message was deleted.
    pub deleted_at: Option<Timestamp>,
}

impl QuarantineMetadata {
    /// Builds quarantined metadata for an accepted message.
    pub fn new(
        message: &Message,
        kind: QuarantineKind,
        quarantine_expires_at: Timestamp,
        now: Timestamp,
    ) -> Self {
        Self {
            message_id: message.id,
            kind,
            status: QuarantineStatus::Quarantined,
            alias_ids: message.alias_ids.clone(),
            sender: message.sender.clone(),
            subject: message.subject.clone(),
            received_at: message.received_at,
            quarantine_expires_at,
            locator: None,
            size_bytes: 0,
            idempotency_key: None,
            delete_reason: None,
            created_at: now,
            updated_at: now,
            recovered_at: None,
            deleted_at: None,
        }
    }
}

/// Retention window and optional quotas for one quarantine kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetentionLimits {
    /// How long a message is held before it is eligible for deletion.
    pub retention: Duration,
    /// Maximum number of messages to keep, if bounded.
    pub count_quota: Option<usize>,
    /// Maximum total body bytes to keep, if bounded.
    pub byte_quota: Option<u64>,
}

impl RetentionLimits {
    /// Limits with only a retention window.
    pub const fn new(retention: Duration) -> Self {
        Self {
            retention,
            count_quota: None,
            byte_quota: None,
        }
    }

    /// Sets a count quota.
    pub const fn with_count_quota(mut self, quota: usize) -> Self {
        self.count_quota = Some(quota);
        self
    }

    /// Sets a byte quota.
    pub const fn with_byte_quota(mut self, quota: u64) -> Self {
        self.byte_quota = Some(quota);
        self
    }
}

/// Retention configuration for lease quarantine and spam.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetentionPolicy {
    /// Lease quarantine retention and quotas.
    pub lease: RetentionLimits,
    /// Spam retention and quotas.
    pub spam: RetentionLimits,
    /// How long deleted metadata is kept before purging.
    pub metadata_purge_grace: Duration,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            lease: RetentionLimits::new(LEASE_QUARANTINE_RETENTION),
            spam: RetentionLimits::new(SPAM_RETENTION),
            metadata_purge_grace: METADATA_PURGE_GRACE,
        }
    }
}

impl RetentionPolicy {
    /// The limits for a quarantine kind.
    pub fn limits(&self, kind: QuarantineKind) -> RetentionLimits {
        match kind {
            QuarantineKind::Lease => self.lease,
            QuarantineKind::Spam => self.spam,
        }
    }
}

/// A point in the recovery or deletion state machine where a crash may occur.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FaultPoint {
    /// Before the inbox copy is written.
    BeforeInboxCopy,
    /// After the inbox copy is written, before the quarantine copy is removed.
    AfterInboxCopy,
    /// Before the quarantine copy is removed.
    BeforeQuarantineDelete,
    /// After the quarantine copy is removed, before recovery is marked.
    AfterQuarantineDelete,
    /// Before the metadata is marked recovered.
    BeforeMarkRecovered,
    /// Before the body is deleted.
    BeforeBodyDelete,
    /// After the body is deleted, before deletion is marked.
    AfterBodyDelete,
    /// Before the metadata is marked deleted.
    BeforeMarkDeleted,
}

/// Injects faults at state-machine boundaries so tests can simulate crashes.
pub trait FaultInjector: Send + Sync {
    /// Returns an error to abort the operation at `point`.
    fn check(&self, point: FaultPoint) -> Result<(), QuarantineError>;
}

/// A fault injector that never fails.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoFaults;

impl FaultInjector for NoFaults {
    fn check(&self, _point: FaultPoint) -> Result<(), QuarantineError> {
        Ok(())
    }
}

/// Quarantine failures.
#[derive(Debug, Error)]
pub enum QuarantineError {
    /// Storage failure.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// Mail-store failure.
    #[error(transparent)]
    Adapter(#[from] AdapterError),
    /// No metadata exists for the message.
    #[error("quarantine metadata not found for message {0}")]
    NotFound(MessageId),
    /// Recovery was requested for a message that is being or has been deleted.
    #[error("message {0} is not recoverable while deletion is in progress")]
    RecoveryBlocked(MessageId),
    /// The inbox copy could not be verified after copying.
    #[error("inbox copy of message {0} could not be verified")]
    VerificationFailed(MessageId),
    /// A test-injected fault aborted the operation.
    #[error("injected fault at {0:?}")]
    Injected(FaultPoint),
}

/// What reconciliation changed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReconciliationReport {
    /// Metadata rows examined.
    pub scanned: usize,
    /// Metadata rows rebuilt from the mail store.
    pub metadata_rebuilt: usize,
    /// Recoveries completed.
    pub completed_recoveries: usize,
    /// Messages returned to quarantine after a crash before the inbox copy.
    pub restored_to_quarantine: usize,
    /// Deletions completed.
    pub completed_deletions: usize,
    /// Duplicate quarantine copies removed in favour of the inbox copy.
    pub removed_duplicate_copies: usize,
    /// Messages marked deleted because their body was gone.
    pub marked_deleted: usize,
    /// Locator cache entries refreshed.
    pub locators_refreshed: usize,
}

/// What a retention sweep changed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RetentionReport {
    /// Messages deleted by retention or quota.
    pub deleted: usize,
    /// Metadata rows purged after the grace period.
    pub purged: usize,
    /// Reconciliation performed before deletion.
    pub reconciled: ReconciliationReport,
}

/// The mailbox a quarantine kind lives in.
pub fn mailbox_for(kind: QuarantineKind) -> &'static str {
    match kind {
        QuarantineKind::Lease => QUARANTINE_MAILBOX,
        QuarantineKind::Spam => SPAM_MAILBOX,
    }
}

/// The quarantine kind for a delivery route, if any.
pub fn kind_for_route(route: Route) -> Option<QuarantineKind> {
    match route {
        Route::Inbox => None,
        Route::Quarantine => Some(QuarantineKind::Lease),
        Route::Spam => Some(QuarantineKind::Spam),
    }
}

/// Drives quarantine recovery, reconciliation, and retention over one store
/// and mail store.
pub struct QuarantineManager<'a> {
    store: &'a Store,
    adapter: &'a MailStoreAdapter,
    policy: RetentionPolicy,
    clock: SharedClock,
}

impl<'a> QuarantineManager<'a> {
    /// Creates a manager with an explicit retention policy and clock.
    pub fn new(
        store: &'a Store,
        adapter: &'a MailStoreAdapter,
        policy: RetentionPolicy,
        clock: SharedClock,
    ) -> Self {
        Self {
            store,
            adapter,
            policy,
            clock,
        }
    }

    /// The retention policy in force.
    pub fn policy(&self) -> &RetentionPolicy {
        &self.policy
    }

    fn now(&self) -> Timestamp {
        self.clock.now()
    }

    /// Loads quarantine metadata by identity.
    pub fn get(
        &self,
        message_id: MessageId,
    ) -> Result<Option<QuarantineMetadata>, QuarantineError> {
        Ok(self.store.get_quarantine_metadata(message_id)?)
    }

    /// Lists quarantine metadata, oldest first.
    pub fn list(&self) -> Result<Vec<QuarantineMetadata>, QuarantineError> {
        Ok(self.store.list_quarantine_metadata()?)
    }

    /// Records quarantine metadata for an accepted delivery.
    ///
    /// The retention window comes from the policy for the message's route. A
    /// message already recorded keeps its existing lifecycle status.
    pub fn record(&self, message: &Message) -> Result<(), QuarantineError> {
        let Some(kind) = kind_for_route(message.route) else {
            return Ok(());
        };
        let expires_at = message
            .received_at
            .checked_add(self.policy.limits(kind).retention)
            .unwrap_or(message.received_at);
        let metadata = QuarantineMetadata::new(message, kind, expires_at, self.now());
        self.store.insert_quarantine_metadata(&metadata)?;
        Ok(())
    }

    /// Recovers a message into the inbox.
    pub fn recover(&self, message_id: MessageId) -> Result<QuarantineMetadata, QuarantineError> {
        self.recover_with(message_id, &NoFaults)
    }

    /// Recovers a message, injecting faults at state-machine boundaries.
    ///
    /// The ordering is: record `recovering` with an idempotency key, copy to
    /// the inbox, verify the inbox copy by message ID, delete the quarantine
    /// copy, and mark `recovered`. Every step is safe to retry.
    pub fn recover_with(
        &self,
        message_id: MessageId,
        faults: &dyn FaultInjector,
    ) -> Result<QuarantineMetadata, QuarantineError> {
        self.reconcile_one(message_id)?;
        let mut metadata = self.require(message_id)?;
        match metadata.status {
            QuarantineStatus::Recovered => return Ok(metadata),
            QuarantineStatus::Deleting | QuarantineStatus::Deleted => {
                return Err(QuarantineError::RecoveryBlocked(message_id));
            }
            QuarantineStatus::Quarantined => {
                metadata.status = QuarantineStatus::Recovering;
                metadata.idempotency_key =
                    Some(metadata.idempotency_key.clone().unwrap_or_else(new_key));
                metadata.updated_at = self.now();
                self.store.upsert_quarantine_metadata(&metadata)?;
            }
            QuarantineStatus::Recovering => {}
        }

        faults.check(FaultPoint::BeforeInboxCopy)?;
        if !self.adapter.contains(INBOX_MAILBOX, message_id)? {
            self.adapter
                .copy_to(QUARANTINE_MAILBOX, INBOX_MAILBOX, message_id)?;
        }
        faults.check(FaultPoint::AfterInboxCopy)?;

        if !self.adapter.contains(INBOX_MAILBOX, message_id)? {
            return Err(QuarantineError::VerificationFailed(message_id));
        }

        faults.check(FaultPoint::BeforeQuarantineDelete)?;
        self.adapter.delete(QUARANTINE_MAILBOX, message_id)?;
        faults.check(FaultPoint::AfterQuarantineDelete)?;

        faults.check(FaultPoint::BeforeMarkRecovered)?;
        self.mark_recovered(&mut metadata)?;
        Ok(metadata)
    }

    /// Deletes a message's body and metadata.
    pub fn delete(
        &self,
        message_id: MessageId,
        reason: DeleteReason,
    ) -> Result<QuarantineMetadata, QuarantineError> {
        self.delete_with(message_id, reason, &NoFaults)
    }

    /// Deletes a message, injecting faults at state-machine boundaries.
    ///
    /// The ordering is: mark `deleting` with a reason, delete the body, then
    /// mark `deleted`. Deleting an already-deleted message is a no-op.
    pub fn delete_with(
        &self,
        message_id: MessageId,
        reason: DeleteReason,
        faults: &dyn FaultInjector,
    ) -> Result<QuarantineMetadata, QuarantineError> {
        self.reconcile_one(message_id)?;
        let mut metadata = self.require(message_id)?;
        if metadata.status == QuarantineStatus::Deleted {
            return Ok(metadata);
        }
        metadata.status = QuarantineStatus::Deleting;
        metadata.delete_reason = Some(reason.as_str().to_string());
        metadata.updated_at = self.now();
        self.store.upsert_quarantine_metadata(&metadata)?;

        let mailbox = mailbox_for(metadata.kind);
        faults.check(FaultPoint::BeforeBodyDelete)?;
        self.adapter.delete(mailbox, message_id)?;
        faults.check(FaultPoint::AfterBodyDelete)?;

        faults.check(FaultPoint::BeforeMarkDeleted)?;
        self.mark_deleted(&mut metadata, reason)?;
        Ok(metadata)
    }

    /// Reconciles metadata with the mail store.
    ///
    /// The mail store is authoritative for membership, so metadata missing
    /// from the database is rebuilt. For each row the inbox copy wins when
    /// both copies exist, a half-finished recovery returns to `quarantined`,
    /// and a half-finished deletion completes.
    pub fn reconcile(&self) -> Result<ReconciliationReport, QuarantineError> {
        let mut report = ReconciliationReport::default();
        let inbox = self.summaries(INBOX_MAILBOX)?;
        let quarantine = self.summaries(QUARANTINE_MAILBOX)?;
        let spam = self.summaries(SPAM_MAILBOX)?;

        for (message_id, summary) in &quarantine {
            if self.store.get_quarantine_metadata(*message_id)?.is_none() {
                self.rebuild_entry(QuarantineKind::Lease, summary, &mut report)?;
            }
        }
        for (message_id, summary) in &spam {
            if self.store.get_quarantine_metadata(*message_id)?.is_none() {
                self.rebuild_entry(QuarantineKind::Spam, summary, &mut report)?;
            }
        }

        for metadata in self.store.list_quarantine_metadata()? {
            report.scanned += 1;
            let mailbox = mailbox_for(metadata.kind);
            let in_inbox = inbox.contains_key(&metadata.message_id);
            let (in_store, summary) = match metadata.kind {
                QuarantineKind::Lease => (
                    quarantine.contains_key(&metadata.message_id),
                    quarantine.get(&metadata.message_id),
                ),
                QuarantineKind::Spam => (
                    spam.contains_key(&metadata.message_id),
                    spam.get(&metadata.message_id),
                ),
            };
            self.reconcile_entry(metadata, mailbox, in_inbox, in_store, summary, &mut report)?;
        }
        Ok(report)
    }

    /// Runs retention and quota enforcement, then purges old metadata.
    ///
    /// Messages in `recovering` or `deleting` are never deleted. Time-expired
    /// messages are removed oldest first, then quotas are enforced oldest
    /// first.
    pub fn retention_sweep(&self) -> Result<RetentionReport, QuarantineError> {
        self.retention_sweep_with(&NoFaults)
    }

    /// Runs retention with fault injection at each deletion boundary.
    pub fn retention_sweep_with(
        &self,
        faults: &dyn FaultInjector,
    ) -> Result<RetentionReport, QuarantineError> {
        let mut report = RetentionReport {
            reconciled: self.reconcile()?,
            ..RetentionReport::default()
        };
        let now = self.now();
        for kind in [QuarantineKind::Lease, QuarantineKind::Spam] {
            let limits = self.policy.limits(kind);
            for metadata in self.eligible(kind)? {
                if metadata.quarantine_expires_at <= now {
                    self.delete_with(metadata.message_id, DeleteReason::Retention, faults)?;
                    report.deleted += 1;
                }
            }

            let remaining = self.eligible(kind)?;
            let mut count = remaining.len();
            let mut bytes: u64 = remaining.iter().map(|entry| entry.size_bytes).sum();
            for metadata in remaining {
                let over_count = limits.count_quota.is_some_and(|quota| count > quota);
                let over_bytes = limits.byte_quota.is_some_and(|quota| bytes > quota);
                if !over_count && !over_bytes {
                    break;
                }
                self.delete_with(metadata.message_id, DeleteReason::Quota, faults)?;
                report.deleted += 1;
                count -= 1;
                bytes = bytes.saturating_sub(metadata.size_bytes);
            }
        }

        let grace = self.policy.metadata_purge_grace;
        let cutoff = now
            .checked_add(Duration::seconds(-grace.whole_seconds()))
            .unwrap_or(now);
        report.purged = self.store.purge_deleted_quarantine_metadata(cutoff)?;
        Ok(report)
    }

    /// Reconciles a single message.
    pub fn reconcile_one(&self, message_id: MessageId) -> Result<(), QuarantineError> {
        let Some(metadata) = self.store.get_quarantine_metadata(message_id)? else {
            return Ok(());
        };
        let mailbox = mailbox_for(metadata.kind);
        let in_inbox = self.adapter.contains(INBOX_MAILBOX, message_id)?;
        let in_store = self.adapter.contains(mailbox, message_id)?;
        let summary = if in_store {
            self.summaries(mailbox)?.get(&message_id).cloned()
        } else {
            None
        };
        let mut report = ReconciliationReport::default();
        self.reconcile_entry(
            metadata,
            mailbox,
            in_inbox,
            in_store,
            summary.as_ref(),
            &mut report,
        )
    }

    fn eligible(&self, kind: QuarantineKind) -> Result<Vec<QuarantineMetadata>, QuarantineError> {
        let mut entries: Vec<QuarantineMetadata> = self
            .store
            .list_quarantine_metadata()?
            .into_iter()
            .filter(|metadata| {
                metadata.kind == kind && metadata.status == QuarantineStatus::Quarantined
            })
            .collect();
        entries.sort_by(|left, right| {
            left.received_at
                .cmp(&right.received_at)
                .then(left.message_id.cmp(&right.message_id))
        });
        Ok(entries)
    }

    fn require(&self, message_id: MessageId) -> Result<QuarantineMetadata, QuarantineError> {
        self.store
            .get_quarantine_metadata(message_id)?
            .ok_or(QuarantineError::NotFound(message_id))
    }

    fn summaries(
        &self,
        mailbox: &str,
    ) -> Result<HashMap<MessageId, MessageSummary>, QuarantineError> {
        Ok(self
            .adapter
            .list(mailbox)?
            .into_iter()
            .map(|summary| (summary.message_id, summary))
            .collect())
    }

    fn reconcile_entry(
        &self,
        mut metadata: QuarantineMetadata,
        mailbox: &str,
        in_inbox: bool,
        in_store: bool,
        summary: Option<&MessageSummary>,
        report: &mut ReconciliationReport,
    ) -> Result<(), QuarantineError> {
        match metadata.status {
            QuarantineStatus::Quarantined => {
                if in_inbox && in_store {
                    self.adapter.delete(mailbox, metadata.message_id)?;
                    self.mark_recovered(&mut metadata)?;
                    report.removed_duplicate_copies += 1;
                    report.completed_recoveries += 1;
                } else if in_inbox {
                    self.mark_recovered(&mut metadata)?;
                    report.completed_recoveries += 1;
                } else if in_store {
                    self.refresh_locator(&mut metadata, summary)?;
                    self.store.upsert_quarantine_metadata(&metadata)?;
                    report.locators_refreshed += 1;
                } else {
                    self.mark_deleted(&mut metadata, DeleteReason::MissingBody)?;
                    report.marked_deleted += 1;
                }
            }
            QuarantineStatus::Recovering => {
                if in_inbox {
                    if in_store {
                        self.adapter.delete(mailbox, metadata.message_id)?;
                        report.removed_duplicate_copies += 1;
                    }
                    self.mark_recovered(&mut metadata)?;
                    report.completed_recoveries += 1;
                } else if in_store {
                    metadata.status = QuarantineStatus::Quarantined;
                    metadata.idempotency_key = None;
                    self.refresh_locator(&mut metadata, summary)?;
                    self.store.upsert_quarantine_metadata(&metadata)?;
                    report.restored_to_quarantine += 1;
                } else {
                    self.mark_deleted(&mut metadata, DeleteReason::MissingBody)?;
                    report.marked_deleted += 1;
                }
            }
            QuarantineStatus::Recovered => {
                if in_store {
                    self.adapter.delete(mailbox, metadata.message_id)?;
                    report.removed_duplicate_copies += 1;
                }
            }
            QuarantineStatus::Deleting => {
                if in_store {
                    self.adapter.delete(mailbox, metadata.message_id)?;
                }
                self.mark_deleted(&mut metadata, DeleteReason::Reconciliation)?;
                report.completed_deletions += 1;
            }
            QuarantineStatus::Deleted => {
                if in_store {
                    self.adapter.delete(mailbox, metadata.message_id)?;
                }
            }
        }
        Ok(())
    }

    fn rebuild_entry(
        &self,
        kind: QuarantineKind,
        summary: &MessageSummary,
        report: &mut ReconciliationReport,
    ) -> Result<(), QuarantineError> {
        let message_id = summary.message_id;
        let bytes = self
            .adapter
            .read(&summary.mailbox, message_id)?
            .unwrap_or_default();
        let parts = MessageParts::parse(&bytes);
        let sender = parts.headers.get("From").unwrap_or("").to_string();
        let subject = parts.headers.get("Subject").unwrap_or("").to_string();
        let received_at = parts
            .headers
            .get("X-Wickmail-Received-At")
            .and_then(|value| value.trim().parse::<Timestamp>().ok())
            .unwrap_or_else(|| self.now());
        let alias_ids: Vec<AliasId> = parts
            .headers
            .get_all("X-Wickmail-Alias-ID")
            .filter_map(|value| value.trim().parse::<AliasId>().ok())
            .collect();
        let route = match kind {
            QuarantineKind::Lease => Route::Quarantine,
            QuarantineKind::Spam => Route::Spam,
        };
        let message = Message {
            id: message_id,
            alias_ids: alias_ids.clone(),
            primary_received: false,
            sender,
            subject,
            received_at,
            route,
        };
        self.store.ensure_message(&message)?;
        for alias_id in &alias_ids {
            if self.store.get_alias(*alias_id)?.is_some() {
                self.store.link_message_alias(message_id, *alias_id)?;
            }
        }
        let expires_at = received_at
            .checked_add(self.policy.limits(kind).retention)
            .unwrap_or(received_at);
        let mut metadata = QuarantineMetadata::new(&message, kind, expires_at, self.now());
        metadata.locator = Some(summary.locator.clone());
        metadata.size_bytes = summary.size;
        self.store.insert_quarantine_metadata(&metadata)?;
        report.metadata_rebuilt += 1;
        Ok(())
    }

    fn refresh_locator(
        &self,
        metadata: &mut QuarantineMetadata,
        summary: Option<&MessageSummary>,
    ) -> Result<(), QuarantineError> {
        let Some(summary) = summary else {
            return Ok(());
        };
        metadata.locator = Some(summary.locator.clone());
        metadata.size_bytes = summary.size;
        metadata.updated_at = self.now();
        Ok(())
    }

    fn mark_recovered(&self, metadata: &mut QuarantineMetadata) -> Result<(), QuarantineError> {
        let now = self.now();
        metadata.status = QuarantineStatus::Recovered;
        metadata.recovered_at = Some(now);
        metadata.updated_at = now;
        self.store.upsert_quarantine_metadata(metadata)?;
        Ok(())
    }

    fn mark_deleted(
        &self,
        metadata: &mut QuarantineMetadata,
        reason: DeleteReason,
    ) -> Result<(), QuarantineError> {
        let now = self.now();
        metadata.status = QuarantineStatus::Deleted;
        metadata.delete_reason = Some(reason.as_str().to_string());
        metadata.deleted_at = Some(now);
        metadata.updated_at = now;
        self.store.upsert_quarantine_metadata(metadata)?;
        Ok(())
    }
}

fn new_key() -> String {
    Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        LEASE_QUARANTINE_RETENTION, QuarantineKind, RetentionLimits, RetentionPolicy,
        SPAM_RETENTION, kind_for_route, mailbox_for,
    };
    use crate::mail::store::{QUARANTINE_MAILBOX, SPAM_MAILBOX};
    use crate::message::Route;
    use time::Duration;

    #[test]
    fn lease_and_spam_retention_defaults_are_separate() {
        assert_eq!(LEASE_QUARANTINE_RETENTION, Duration::days(30));
        assert_eq!(SPAM_RETENTION, Duration::days(14));
        assert_ne!(LEASE_QUARANTINE_RETENTION, SPAM_RETENTION);

        let policy = RetentionPolicy::default();
        assert_eq!(
            policy.limits(QuarantineKind::Lease).retention,
            Duration::days(30)
        );
        assert_eq!(
            policy.limits(QuarantineKind::Spam).retention,
            Duration::days(14)
        );
    }

    #[test]
    fn limits_can_carry_quotas() {
        let limits = RetentionLimits::new(Duration::days(1))
            .with_count_quota(10)
            .with_byte_quota(1024);
        assert_eq!(limits.count_quota, Some(10));
        assert_eq!(limits.byte_quota, Some(1024));
    }

    #[test]
    fn routes_map_to_kinds_and_mailboxes() {
        assert_eq!(kind_for_route(Route::Inbox), None);
        assert_eq!(
            kind_for_route(Route::Quarantine),
            Some(QuarantineKind::Lease)
        );
        assert_eq!(kind_for_route(Route::Spam), Some(QuarantineKind::Spam));
        assert_eq!(mailbox_for(QuarantineKind::Lease), QUARANTINE_MAILBOX);
        assert_eq!(mailbox_for(QuarantineKind::Spam), SPAM_MAILBOX);
    }
}
