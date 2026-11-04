//! Abuse controls for the inbound mail path.
//!
//! The server enforces a maximum message size, per-alias and global quarantine
//! count and byte quotas, and per-sender and global rate limits. A full disk
//! returns a temporary failure, raises an alert, and never acknowledges a
//! message that was not durably spooled.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use time::Duration;

use crate::timestamp::Timestamp;

/// Default maximum accepted message size: 10 MiB.
pub const DEFAULT_MAX_MESSAGE_BYTES: usize = 10 * 1024 * 1024;

/// Default per-sender rate limit: 100 messages per hour.
pub const DEFAULT_PER_SENDER_LIMIT: u32 = 100;

/// Default global rate limit: 1000 messages per hour.
pub const DEFAULT_GLOBAL_LIMIT: u32 = 1000;

/// Default per-alias quarantine count quota.
pub const DEFAULT_PER_ALIAS_COUNT: usize = 100;

/// Default per-alias quarantine byte quota: 100 MiB.
pub const DEFAULT_PER_ALIAS_BYTES: u64 = 100 * 1024 * 1024;

/// A fixed-window rate limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RateLimit {
    /// Maximum events allowed inside the window.
    pub capacity: u32,
    /// Window length in seconds.
    pub window_seconds: i64,
}

impl RateLimit {
    /// A limit of `capacity` events per hour.
    pub const fn per_hour(capacity: u32) -> Self {
        Self {
            capacity,
            window_seconds: 3600,
        }
    }
}

/// Why a request was rate limited.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RateLimited {
    /// Seconds until the oldest event leaves the window.
    pub retry_after_seconds: i64,
}

/// A sliding-window rate limiter keyed by an arbitrary string.
#[derive(Debug, Default)]
pub struct RateLimiter {
    windows: Mutex<HashMap<String, VecDeque<Timestamp>>>,
}

impl RateLimiter {
    /// Creates an empty limiter.
    pub fn new() -> Self {
        Self::default()
    }

    /// Records an event for `key`, failing when the limit is already reached.
    pub fn check(&self, key: &str, limit: RateLimit, now: Timestamp) -> Result<(), RateLimited> {
        self.check_within(key, limit, now)
    }

    /// Records a global event, failing when the global limit is reached.
    pub fn check_global(&self, limit: RateLimit, now: Timestamp) -> Result<(), RateLimited> {
        self.check_within("\u{0}global", limit, now)
    }

    fn check_within(&self, key: &str, limit: RateLimit, now: Timestamp) -> Result<(), RateLimited> {
        let mut windows = self.windows.lock().expect("rate limiter lock poisoned");
        let window = windows.entry(key.to_string()).or_default();
        let cutoff = now
            .checked_add(Duration::seconds(-limit.window_seconds))
            .unwrap_or(now);
        while window.front().is_some_and(|event| *event <= cutoff) {
            window.pop_front();
        }
        if window.len() >= limit.capacity as usize {
            let oldest = window.front().copied().unwrap_or(now);
            let expiry = oldest
                .checked_add(Duration::seconds(limit.window_seconds))
                .unwrap_or(now);
            let retry_after = ((expiry.unix_millis() - now.unix_millis()) / 1000).max(1);
            return Err(RateLimited {
                retry_after_seconds: retry_after.max(1),
            });
        }
        window.push_back(now);
        Ok(())
    }

    /// Drops empty windows so memory does not grow with unique senders.
    pub fn prune(&self, now: Timestamp) {
        let mut windows = self.windows.lock().expect("rate limiter lock poisoned");
        windows.retain(|_, window| {
            window.back().is_some_and(|last| {
                last.checked_add(Duration::hours(1))
                    .is_some_and(|t| t > now)
            })
        });
    }
}

/// Inbound abuse policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AbusePolicy {
    /// Maximum accepted message size in bytes.
    pub max_message_bytes: usize,
    /// Per-sender rate limit.
    pub per_sender: Option<RateLimit>,
    /// Global rate limit.
    pub global: Option<RateLimit>,
    /// Maximum quarantined messages per alias.
    pub per_alias_quarantine_count: Option<usize>,
    /// Maximum quarantined bytes per alias.
    pub per_alias_quarantine_bytes: Option<u64>,
}

impl Default for AbusePolicy {
    fn default() -> Self {
        Self {
            max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
            per_sender: Some(RateLimit::per_hour(DEFAULT_PER_SENDER_LIMIT)),
            global: Some(RateLimit::per_hour(DEFAULT_GLOBAL_LIMIT)),
            per_alias_quarantine_count: Some(DEFAULT_PER_ALIAS_COUNT),
            per_alias_quarantine_bytes: Some(DEFAULT_PER_ALIAS_BYTES),
        }
    }
}

impl AbusePolicy {
    /// A policy that disables every abuse control, for tests that do not
    /// exercise them.
    pub const fn disabled() -> Self {
        Self {
            max_message_bytes: usize::MAX,
            per_sender: None,
            global: None,
            per_alias_quarantine_count: None,
            per_alias_quarantine_bytes: None,
        }
    }

    /// Whether `size` exceeds the configured maximum.
    pub fn rejects_size(&self, size: usize) -> bool {
        size > self.max_message_bytes
    }
}

/// A condition worth alerting on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlertKind {
    /// The disk or spool is full.
    DiskFull,
    /// A quarantine quota was exceeded.
    QuotaExceeded,
    /// A rate limit was hit.
    RateLimited,
    /// The durable spool rejected a message.
    SpoolFailure,
}

impl AlertKind {
    /// A stable machine-readable label.
    pub fn as_str(self) -> &'static str {
        match self {
            AlertKind::DiskFull => "disk_full",
            AlertKind::QuotaExceeded => "quota_exceeded",
            AlertKind::RateLimited => "rate_limited",
            AlertKind::SpoolFailure => "spool_failure",
        }
    }
}

/// Receives alerts raised by the mail path.
pub trait Alerter: Send + Sync {
    /// Records an alert.
    fn alert(&self, kind: AlertKind, message: &str);
}

/// An alerter that writes to standard error.
#[derive(Clone, Copy, Debug, Default)]
pub struct LogAlerter;

impl Alerter for LogAlerter {
    fn alert(&self, kind: AlertKind, message: &str) {
        eprintln!("wickmail: alert [{}] {}", kind.as_str(), message);
    }
}

/// An alerter that records alerts in memory, for tests.
#[derive(Debug, Default)]
pub struct RecordingAlerter {
    alerts: Mutex<Vec<(AlertKind, String)>>,
}

impl RecordingAlerter {
    /// Creates an empty recorder.
    pub fn new() -> Self {
        Self::default()
    }

    /// The recorded alerts, oldest first.
    pub fn alerts(&self) -> Vec<(AlertKind, String)> {
        self.alerts.lock().expect("alert lock poisoned").clone()
    }

    /// The recorded alert kinds.
    pub fn kinds(&self) -> Vec<AlertKind> {
        self.alerts
            .lock()
            .expect("alert lock poisoned")
            .iter()
            .map(|(kind, _)| *kind)
            .collect()
    }
}

impl Alerter for RecordingAlerter {
    fn alert(&self, kind: AlertKind, message: &str) {
        self.alerts
            .lock()
            .expect("alert lock poisoned")
            .push((kind, message.to_string()));
    }
}

/// The Linux `ENOSPC` error number.
const ENOSPC: i32 = 28;

/// Whether an I/O error means the filesystem is full.
pub fn is_disk_full(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(ENOSPC)
}

#[cfg(test)]
mod tests {
    use super::{
        AbusePolicy, AlertKind, Alerter, RateLimit, RateLimiter, RecordingAlerter, is_disk_full,
    };
    use crate::timestamp::Timestamp;

    fn at(value: &str) -> Timestamp {
        value.parse().unwrap()
    }

    #[test]
    fn per_sender_rate_limit_is_enforced() {
        let limiter = RateLimiter::new();
        let limit = RateLimit {
            capacity: 2,
            window_seconds: 60,
        };
        let now = at("2026-01-01T00:00:00Z");
        assert!(limiter.check("sender@example.com", limit, now).is_ok());
        assert!(limiter.check("sender@example.com", limit, now).is_ok());
        let denied = limiter.check("sender@example.com", limit, now).unwrap_err();
        assert!(denied.retry_after_seconds > 0);
        // A different sender is unaffected.
        assert!(limiter.check("other@example.com", limit, now).is_ok());
        // The window slides.
        assert!(
            limiter
                .check("sender@example.com", limit, at("2026-01-01T00:02:00Z"))
                .is_ok()
        );
    }

    #[test]
    fn global_and_per_sender_windows_are_independent() {
        let limiter = RateLimiter::new();
        let limit = RateLimit {
            capacity: 1,
            window_seconds: 60,
        };
        let now = at("2026-01-01T00:00:00Z");
        assert!(limiter.check("a", limit, now).is_ok());
        assert!(limiter.check_global(limit, now).is_ok());
        assert!(limiter.check("b", limit, now).is_ok());
        assert!(limiter.check_global(limit, now).is_err());
    }

    #[test]
    fn size_limits_and_alerts() {
        let policy = AbusePolicy::default();
        assert!(!policy.rejects_size(1024));
        assert!(policy.rejects_size(policy.max_message_bytes + 1));

        let recorder = RecordingAlerter::new();
        recorder.alert(AlertKind::DiskFull, "spool is full");
        assert_eq!(recorder.kinds(), vec![AlertKind::DiskFull]);
    }

    #[test]
    fn detects_disk_full_errors() {
        let full = std::io::Error::from_raw_os_error(super::ENOSPC);
        assert!(is_disk_full(&full));
        let other = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "nope");
        assert!(!is_disk_full(&other));
    }
}
