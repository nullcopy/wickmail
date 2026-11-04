//! Time source abstraction so lease evaluation is testable.

use std::sync::Arc;

use time::Duration;

use crate::timestamp::Timestamp;

/// Supplies the current time to lease evaluation.
pub trait Clock: Send + Sync {
    /// The current time in UTC.
    fn now(&self) -> Timestamp;
}

/// Reads the wall clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Timestamp {
        Timestamp::now()
    }
}

/// A clock that returns a fixed instant and can be advanced in tests.
#[derive(Clone, Copy, Debug)]
pub struct FixedClock {
    now: Timestamp,
}

impl FixedClock {
    /// Creates a clock pinned to `now`.
    pub fn new(now: Timestamp) -> Self {
        Self { now }
    }

    /// Moves the clock forward by `duration`.
    pub fn advance(&mut self, duration: Duration) {
        if let Some(next) = self.now.checked_add(duration) {
            self.now = next;
        }
    }

    /// Sets the clock to `now`.
    pub fn set(&mut self, now: Timestamp) {
        self.now = now;
    }
}

impl Clock for FixedClock {
    fn now(&self) -> Timestamp {
        self.now
    }
}

/// A shared, type-erased clock.
pub type SharedClock = Arc<dyn Clock>;

#[cfg(test)]
mod tests {
    use super::{Clock, FixedClock};
    use crate::timestamp::Timestamp;
    use time::Duration;

    #[test]
    fn fixed_clock_advances() {
        let mut clock = FixedClock::new("2026-01-01T00:00:00Z".parse().unwrap());
        clock.advance(Duration::hours(1));
        assert_eq!(
            clock.now(),
            "2026-01-01T01:00:00Z".parse::<Timestamp>().unwrap()
        );
    }
}
