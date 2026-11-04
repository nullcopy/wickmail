//! Lease evaluation and the renewal truth tables.
//!
//! Effective state is computed from stored fields at evaluation time; no
//! scheduler is required for correctness. State precedence is disabled, then
//! expired, then active.

use thiserror::Error;
use time::Duration;

use crate::alias::{Alias, AliasState};
use crate::audit::AuditEventKind;
use crate::timestamp::Timestamp;

/// Why a lease operation could not be applied.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum LeaseError {
    /// The alias is disabled and the action requires it to be enabled.
    #[error("alias is disabled")]
    Disabled,
    /// The alias is already enabled.
    #[error("alias is already enabled")]
    AlreadyEnabled,
    /// Extending requires an existing expiry.
    #[error("alias has no expiry to extend")]
    NoExpiry,
    /// The supplied duration was zero or negative.
    #[error("lease duration must be positive")]
    InvalidDuration,
    /// The resulting expiry would be out of range.
    #[error("expiry overflowed the representable range")]
    Overflow,
}

/// Effective lifecycle state at `now`: disabled over expired over active.
pub fn evaluate_state(alias: &Alias, now: Timestamp) -> AliasState {
    if alias.disabled_at.is_some() {
        AliasState::Disabled
    } else if alias.expires_at.is_some_and(|expires| expires <= now) {
        AliasState::Expired
    } else {
        AliasState::Active
    }
}

/// The result of evaluating an authenticated outbound submission.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutboundDecision {
    /// Accept and set `expires_at = now + lease_duration`.
    AcceptRenew,
    /// Accept without changing the lease.
    AcceptUnchanged,
    /// Reject because the alias is disabled.
    RejectDisabled,
    /// Reject because the lease expired and `renew_on_outbound` is false.
    RejectExpired,
}

/// Evaluates the outbound submission truth table.
///
/// An alias with no expiry ignores outbound renewal until an expiry is set.
pub fn evaluate_outbound(alias: &Alias, now: Timestamp) -> OutboundDecision {
    match evaluate_state(alias, now) {
        AliasState::Disabled => OutboundDecision::RejectDisabled,
        AliasState::Expired => {
            if alias.renew_on_outbound {
                OutboundDecision::AcceptRenew
            } else {
                OutboundDecision::RejectExpired
            }
        }
        AliasState::Active => {
            if alias.expires_at.is_some() && alias.renew_on_outbound {
                OutboundDecision::AcceptRenew
            } else {
                OutboundDecision::AcceptUnchanged
            }
        }
    }
}

/// Applies the outbound decision to `alias` and returns it.
pub fn apply_outbound(alias: &mut Alias, now: Timestamp) -> OutboundDecision {
    let decision = evaluate_outbound(alias, now);
    match decision {
        OutboundDecision::AcceptRenew => {
            if let Some(expires) = now.checked_add(alias.lease_duration()) {
                alias.expires_at = Some(expires);
            }
            alias.last_user_activity_at = Some(now);
        }
        OutboundDecision::AcceptUnchanged => {
            alias.last_user_activity_at = Some(now);
        }
        OutboundDecision::RejectDisabled | OutboundDecision::RejectExpired => {}
    }
    decision
}

/// Records accepted inbound mail. Informational only; never changes the lease.
pub fn record_inbound(alias: &mut Alias, at: Timestamp) {
    alias.last_inbound_at = Some(at);
}

/// An explicit user action from the management API.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ManualAction {
    /// `expires_at = now +` supplied duration, or `lease_duration` if omitted.
    Renew {
        /// Supplied duration in seconds, or the alias default.
        seconds: Option<i64>,
    },
    /// `expires_at = max(now, expires_at) +` supplied or default duration.
    Extend {
        /// Supplied duration in seconds, or the alias default.
        seconds: Option<i64>,
    },
    /// Sets an absolute expiry; `lease_duration` is unchanged.
    SetExpiry {
        /// The absolute expiry to set.
        expires_at: Timestamp,
    },
    /// Clears the expiry; `lease_duration` is unchanged.
    RemoveExpiry,
    /// Sets `disabled_at`; the lease is unchanged.
    Disable,
    /// Clears `disabled_at` and sets a new lease.
    Enable {
        /// Optional explicit expiry, otherwise `now + lease_duration`.
        expires_at: Option<Timestamp>,
    },
}

/// Applies a manual action and returns the audit events it produces.
///
/// `last_user_activity_at` updates for renew, extend, set expiry, remove
/// expiry, and enable, and does not update for disable.
pub fn apply_manual_action(
    alias: &mut Alias,
    action: ManualAction,
    now: Timestamp,
) -> Result<Vec<AuditEventKind>, LeaseError> {
    match action {
        ManualAction::Renew { seconds } => {
            require_enabled(alias)?;
            let seconds = resolve_seconds(alias, seconds)?;
            alias.expires_at = Some(add_seconds(now, seconds)?);
            alias.last_user_activity_at = Some(now);
            Ok(vec![AuditEventKind::ManuallyRenewed])
        }
        ManualAction::Extend { seconds } => {
            require_enabled(alias)?;
            let expires_at = alias.expires_at.ok_or(LeaseError::NoExpiry)?;
            let seconds = resolve_seconds(alias, seconds)?;
            let base = expires_at.max(now);
            alias.expires_at = Some(add_seconds(base, seconds)?);
            alias.last_user_activity_at = Some(now);
            Ok(vec![AuditEventKind::ManuallyExtended])
        }
        ManualAction::SetExpiry { expires_at } => {
            require_enabled(alias)?;
            alias.expires_at = Some(expires_at);
            alias.last_user_activity_at = Some(now);
            Ok(vec![AuditEventKind::ExpirySet])
        }
        ManualAction::RemoveExpiry => {
            require_enabled(alias)?;
            alias.expires_at = None;
            alias.last_user_activity_at = Some(now);
            Ok(vec![AuditEventKind::ExpiryRemoved])
        }
        ManualAction::Disable => {
            alias.disabled_at = Some(now);
            Ok(vec![AuditEventKind::Disabled])
        }
        ManualAction::Enable { expires_at } => {
            if alias.disabled_at.is_none() {
                return Err(LeaseError::AlreadyEnabled);
            }
            alias.disabled_at = None;
            alias.expires_at = match expires_at {
                Some(explicit) => Some(explicit),
                None => Some(add_seconds(now, alias.lease_duration_seconds)?),
            };
            alias.last_user_activity_at = Some(now);
            Ok(vec![AuditEventKind::Enabled])
        }
    }
}

fn require_enabled(alias: &Alias) -> Result<(), LeaseError> {
    if alias.disabled_at.is_some() {
        Err(LeaseError::Disabled)
    } else {
        Ok(())
    }
}

fn resolve_seconds(alias: &Alias, seconds: Option<i64>) -> Result<i64, LeaseError> {
    let seconds = seconds.unwrap_or(alias.lease_duration_seconds);
    if seconds <= 0 {
        return Err(LeaseError::InvalidDuration);
    }
    Ok(seconds)
}

fn add_seconds(base: Timestamp, seconds: i64) -> Result<Timestamp, LeaseError> {
    base.checked_add(Duration::seconds(seconds))
        .ok_or(LeaseError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::{
        LeaseError, ManualAction, OutboundDecision, apply_manual_action, apply_outbound,
        evaluate_outbound, evaluate_state, record_inbound,
    };
    use crate::address::CanonicalAddress;
    use crate::alias::{Alias, AliasId, AliasState, DEFAULT_LEASE_SECONDS};
    use crate::timestamp::Timestamp;

    fn at(value: &str) -> Timestamp {
        value.parse().unwrap()
    }

    fn alias() -> Alias {
        Alias {
            id: AliasId::from_uuid("018f9b60-0000-7000-8000-000000000000".parse().unwrap()),
            address: CanonicalAddress::parse("green.farm@example.com").unwrap(),
            label: None,
            purpose: None,
            created_at: at("2026-01-01T00:00:00Z"),
            expires_at: Some(at("2026-01-08T00:00:00Z")),
            disabled_at: None,
            lease_duration_seconds: DEFAULT_LEASE_SECONDS,
            renew_on_outbound: true,
            last_inbound_at: None,
            last_user_activity_at: None,
            policy_version: 0,
        }
    }

    #[test]
    fn state_precedence_is_disabled_then_expired_then_active() {
        let now = at("2026-01-04T00:00:00Z");

        let active = alias();
        assert_eq!(evaluate_state(&active, now), AliasState::Active);

        let expired = alias();
        assert_eq!(
            evaluate_state(&expired, at("2026-02-01T00:00:00Z")),
            AliasState::Expired
        );

        let mut disabled = alias();
        disabled.disabled_at = Some(now);
        assert_eq!(evaluate_state(&disabled, now), AliasState::Disabled);
        assert_eq!(
            evaluate_state(&disabled, at("2026-02-01T00:00:00Z")),
            AliasState::Disabled
        );
    }

    #[test]
    fn expiry_boundary_is_expired() {
        let now = at("2026-01-08T00:00:00Z");
        assert_eq!(evaluate_state(&alias(), now), AliasState::Expired);
    }

    #[test]
    fn outbound_truth_table() {
        let now = at("2026-01-04T00:00:00Z");

        // Active, renew on.
        assert_eq!(
            evaluate_outbound(&alias(), now),
            OutboundDecision::AcceptRenew
        );

        // Active, renew off.
        let mut active_off = alias();
        active_off.renew_on_outbound = false;
        assert_eq!(
            evaluate_outbound(&active_off, now),
            OutboundDecision::AcceptUnchanged
        );

        // Expired, renew on.
        let expired_on = alias();
        assert_eq!(
            evaluate_outbound(&expired_on, at("2026-02-01T00:00:00Z")),
            OutboundDecision::AcceptRenew
        );

        // Expired, renew off.
        let mut expired_off = alias();
        expired_off.renew_on_outbound = false;
        assert_eq!(
            evaluate_outbound(&expired_off, at("2026-02-01T00:00:00Z")),
            OutboundDecision::RejectExpired
        );

        // Disabled, either.
        let mut disabled = alias();
        disabled.disabled_at = Some(now);
        assert_eq!(
            evaluate_outbound(&disabled, now),
            OutboundDecision::RejectDisabled
        );
    }

    #[test]
    fn no_expiry_alias_ignores_outbound_renewal() {
        let now = at("2026-01-04T00:00:00Z");
        let mut alias = alias();
        alias.expires_at = None;
        assert_eq!(
            evaluate_outbound(&alias, now),
            OutboundDecision::AcceptUnchanged
        );

        apply_outbound(&mut alias, now);
        assert_eq!(alias.expires_at, None);
        assert_eq!(alias.last_user_activity_at, Some(now));
    }

    #[test]
    fn outbound_renewal_resets_expiry_from_now() {
        let now = at("2026-01-04T00:00:00Z");
        let mut alias = alias();
        assert_eq!(
            apply_outbound(&mut alias, now),
            OutboundDecision::AcceptRenew
        );
        assert_eq!(alias.expires_at, Some(at("2026-01-11T00:00:00Z")));
        assert_eq!(alias.last_user_activity_at, Some(now));
    }

    #[test]
    fn rejected_outbound_leaves_alias_untouched() {
        let now = at("2026-02-01T00:00:00Z");
        let mut alias = alias();
        alias.renew_on_outbound = false;
        let before = alias.clone();
        assert_eq!(
            apply_outbound(&mut alias, now),
            OutboundDecision::RejectExpired
        );
        assert_eq!(alias, before);
    }

    #[test]
    fn inbound_never_changes_the_lease() {
        let mut alias = alias();
        let expires = alias.expires_at;
        record_inbound(&mut alias, at("2026-02-01T00:00:00Z"));
        assert_eq!(alias.expires_at, expires);
        assert_eq!(alias.last_inbound_at, Some(at("2026-02-01T00:00:00Z")));
        assert_eq!(alias.last_user_activity_at, None);
    }

    #[test]
    fn renew_uses_supplied_or_default_duration() {
        let now = at("2026-01-04T00:00:00Z");

        let mut with_default = alias();
        apply_manual_action(
            &mut with_default,
            ManualAction::Renew { seconds: None },
            now,
        )
        .unwrap();
        assert_eq!(with_default.expires_at, Some(at("2026-01-11T00:00:00Z")));

        let mut with_supplied = alias();
        apply_manual_action(
            &mut with_supplied,
            ManualAction::Renew {
                seconds: Some(24 * 60 * 60),
            },
            now,
        )
        .unwrap();
        assert_eq!(with_supplied.expires_at, Some(at("2026-01-05T00:00:00Z")));
        assert_eq!(with_supplied.lease_duration_seconds, DEFAULT_LEASE_SECONDS);
    }

    #[test]
    fn extend_uses_later_of_now_and_expiry() {
        let now = at("2026-01-04T00:00:00Z");

        let mut unexpired = alias();
        apply_manual_action(
            &mut unexpired,
            ManualAction::Extend {
                seconds: Some(24 * 60 * 60),
            },
            now,
        )
        .unwrap();
        assert_eq!(unexpired.expires_at, Some(at("2026-01-09T00:00:00Z")));

        let mut expired = alias();
        apply_manual_action(
            &mut expired,
            ManualAction::Extend {
                seconds: Some(24 * 60 * 60),
            },
            at("2026-02-01T00:00:00Z"),
        )
        .unwrap();
        assert_eq!(expired.expires_at, Some(at("2026-02-02T00:00:00Z")));
    }

    #[test]
    fn extend_requires_an_expiry() {
        let now = at("2026-01-04T00:00:00Z");
        let mut alias = alias();
        alias.expires_at = None;
        assert_eq!(
            apply_manual_action(&mut alias, ManualAction::Extend { seconds: None }, now),
            Err(LeaseError::NoExpiry)
        );
    }

    #[test]
    fn set_and_remove_expiry_leave_lease_duration() {
        let now = at("2026-01-04T00:00:00Z");
        let mut alias = alias();
        apply_manual_action(
            &mut alias,
            ManualAction::SetExpiry {
                expires_at: at("2027-01-01T00:00:00Z"),
            },
            now,
        )
        .unwrap();
        assert_eq!(alias.expires_at, Some(at("2027-01-01T00:00:00Z")));
        assert_eq!(alias.lease_duration_seconds, DEFAULT_LEASE_SECONDS);
        assert_eq!(alias.last_user_activity_at, Some(now));

        apply_manual_action(&mut alias, ManualAction::RemoveExpiry, now).unwrap();
        assert_eq!(alias.expires_at, None);
        assert_eq!(alias.lease_duration_seconds, DEFAULT_LEASE_SECONDS);
    }

    #[test]
    fn disable_does_not_update_user_activity() {
        let now = at("2026-01-04T00:00:00Z");
        let mut alias = alias();
        let expires = alias.expires_at;
        apply_manual_action(&mut alias, ManualAction::Disable, now).unwrap();
        assert_eq!(alias.disabled_at, Some(now));
        assert_eq!(alias.expires_at, expires);
        assert_eq!(alias.last_user_activity_at, None);
    }

    #[test]
    fn enable_requires_disabled_state_and_sets_a_new_lease() {
        let now = at("2026-01-04T00:00:00Z");
        let mut alias = alias();
        assert_eq!(
            apply_manual_action(&mut alias, ManualAction::Enable { expires_at: None }, now),
            Err(LeaseError::AlreadyEnabled)
        );

        alias.disabled_at = Some(at("2026-01-02T00:00:00Z"));
        apply_manual_action(&mut alias, ManualAction::Enable { expires_at: None }, now).unwrap();
        assert_eq!(alias.disabled_at, None);
        assert_eq!(alias.expires_at, Some(at("2026-01-11T00:00:00Z")));
        assert_eq!(alias.last_user_activity_at, Some(now));
    }

    #[test]
    fn enabled_actions_reject_a_disabled_alias() {
        let now = at("2026-01-04T00:00:00Z");
        let mut alias = alias();
        alias.disabled_at = Some(now);
        assert_eq!(
            apply_manual_action(&mut alias, ManualAction::Renew { seconds: None }, now),
            Err(LeaseError::Disabled)
        );
        assert_eq!(
            apply_manual_action(&mut alias, ManualAction::RemoveExpiry, now),
            Err(LeaseError::Disabled)
        );
    }

    #[test]
    fn non_positive_duration_is_rejected() {
        let now = at("2026-01-04T00:00:00Z");
        let mut alias = alias();
        assert_eq!(
            apply_manual_action(&mut alias, ManualAction::Renew { seconds: Some(0) }, now),
            Err(LeaseError::InvalidDuration)
        );
    }
}
