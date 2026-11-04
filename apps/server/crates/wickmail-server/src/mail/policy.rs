//! Recipient policy: canonical lookup and the RCPT decision.
//!
//! The same resolver backs both enforcement points. At RCPT it produces an
//! accept/reject/temporary decision; at delivery it classifies each envelope
//! recipient so the proxy can route the message.

use std::sync::{Arc, Mutex};

use thiserror::Error;

use crate::address::{AddressError, CanonicalAddress};
use crate::alias::{AliasId, AliasState};
use crate::db::StoreError;
use crate::lease::evaluate_state;
use crate::service::AliasService;

/// How an envelope recipient maps to the account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecipientKind {
    /// The account's primary address.
    Primary,
    /// A known alias and its delivery-time state.
    Alias {
        /// The alias identity.
        id: AliasId,
        /// Effective state evaluated at delivery time.
        state: AliasState,
    },
    /// No alias or primary address matches.
    Unknown,
}

/// Why a recipient could not be resolved.
#[derive(Debug, Error)]
pub enum PolicyError {
    /// The alias database could not be read.
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// The RCPT-time decision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyDecision {
    /// Accept the recipient. Active and expired aliases are both accepted.
    Accept,
    /// Reject with a permanent SMTP failure.
    Reject(String),
    /// Return a temporary failure. Never reported as an unknown recipient.
    Temporary(String),
}

/// Resolves canonical recipients against the primary address and alias store.
pub struct RecipientPolicy {
    primary: CanonicalAddress,
    service: Arc<Mutex<AliasService>>,
}

impl RecipientPolicy {
    /// Creates a policy over the primary address and a shared service.
    pub fn new(primary: CanonicalAddress, service: Arc<Mutex<AliasService>>) -> Self {
        Self { primary, service }
    }

    /// The primary address.
    pub fn primary(&self) -> &CanonicalAddress {
        &self.primary
    }

    /// Classifies a canonical recipient.
    pub fn resolve(&self, address: &CanonicalAddress) -> Result<RecipientKind, PolicyError> {
        if address == &self.primary {
            return Ok(RecipientKind::Primary);
        }
        let service = self.service.lock().expect("policy lock poisoned");
        let Some(alias) = service.store().get_alias_by_address(address)? else {
            return Ok(RecipientKind::Unknown);
        };
        let state = evaluate_state(&alias, service.now());
        Ok(RecipientKind::Alias {
            id: alias.id,
            state,
        })
    }

    /// Produces the RCPT decision for a raw recipient string.
    ///
    /// Unknown and disabled recipients are rejected permanently; active and
    /// expired recipients are accepted. A storage failure returns a temporary
    /// failure so an internal error is never mistaken for an unknown recipient.
    pub fn decide(&self, raw: &str) -> PolicyDecision {
        let address = match CanonicalAddress::parse(raw) {
            Ok(address) => address,
            Err(AddressError::MissingSeparator | AddressError::EmptyPart) => {
                return PolicyDecision::Reject("unknown recipient".to_string());
            }
            Err(error) => return PolicyDecision::Reject(error.to_string()),
        };
        match self.resolve(&address) {
            Ok(RecipientKind::Primary) => PolicyDecision::Accept,
            Ok(RecipientKind::Alias {
                state: AliasState::Disabled,
                ..
            }) => PolicyDecision::Reject("recipient disabled".to_string()),
            Ok(RecipientKind::Alias { .. }) => PolicyDecision::Accept,
            Ok(RecipientKind::Unknown) => PolicyDecision::Reject("unknown recipient".to_string()),
            Err(error) => PolicyDecision::Temporary(error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{PolicyDecision, RecipientKind, RecipientPolicy};
    use crate::address::{CanonicalAddress, Domain};
    use crate::alias::{AliasState, DEFAULT_LEASE_SECONDS};
    use crate::clock::FixedClock;
    use crate::db::Store;
    use crate::generator::AliasGenerator;
    use crate::service::{AliasService, ExpiryChoice};
    use crate::timestamp::Timestamp;
    use std::sync::{Arc, Mutex};

    fn at(value: &str) -> Timestamp {
        value.parse().unwrap()
    }

    fn policy(now: &str) -> RecipientPolicy {
        let mut store = Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        let service = AliasService::new(
            store,
            AliasGenerator::from_words(vec!["green", "farm"]),
            Domain::parse("example.com").unwrap(),
            Arc::new(FixedClock::new(at(now))),
        );
        RecipientPolicy::new(
            CanonicalAddress::parse("user@example.com").unwrap(),
            Arc::new(Mutex::new(service)),
        )
    }

    fn create(policy: &RecipientPolicy, local: &str, expiry: ExpiryChoice) -> crate::alias::Alias {
        let service = policy.service.lock().unwrap();
        let address = CanonicalAddress::parse(&format!("{local}@example.com")).unwrap();
        service
            .store()
            .insert_alias(&crate::alias::Alias {
                id: crate::alias::AliasId::new(),
                address: address.clone(),
                label: None,
                purpose: None,
                created_at: at("2026-01-01T00:00:00Z"),
                expires_at: match expiry {
                    ExpiryChoice::LeaseSeconds(_) => Some(at("2026-01-08T00:00:00Z")),
                    ExpiryChoice::Absolute(value) => Some(value),
                    ExpiryChoice::Never => None,
                },
                disabled_at: None,
                lease_duration_seconds: DEFAULT_LEASE_SECONDS,
                renew_on_outbound: true,
                last_inbound_at: None,
                last_user_activity_at: None,
                policy_version: 0,
            })
            .unwrap();
        service
            .store()
            .get_alias_by_address(&address)
            .unwrap()
            .unwrap()
    }

    #[test]
    fn accepts_the_primary_address() {
        let policy = policy("2026-01-04T00:00:00Z");
        assert_eq!(policy.decide("user@example.com"), PolicyDecision::Accept);
        assert_eq!(policy.decide("USER@Example.COM"), PolicyDecision::Accept);
    }

    #[test]
    fn accepts_active_and_expired_aliases() {
        let policy = policy("2026-01-04T00:00:00Z");
        let active = create(&policy, "green.farm", ExpiryChoice::LeaseSeconds(None));
        assert_eq!(
            policy.resolve(&active.address).unwrap(),
            RecipientKind::Alias {
                id: active.id,
                state: AliasState::Active,
            }
        );
        assert_eq!(
            policy.decide("green.farm@example.com"),
            PolicyDecision::Accept
        );

        let expired = create(
            &policy,
            "old.farm",
            ExpiryChoice::Absolute(at("2026-01-02T00:00:00Z")),
        );
        assert_eq!(
            policy.resolve(&expired.address).unwrap(),
            RecipientKind::Alias {
                id: expired.id,
                state: AliasState::Expired,
            }
        );
        assert_eq!(
            policy.decide("old.farm@example.com"),
            PolicyDecision::Accept
        );
    }

    #[test]
    fn rejects_unknown_recipients() {
        let policy = policy("2026-01-04T00:00:00Z");
        assert!(matches!(
            policy.decide("nobody@example.com"),
            PolicyDecision::Reject(_)
        ));
    }

    #[test]
    fn rejects_disabled_recipients() {
        let policy = policy("2026-01-04T00:00:00Z");
        let alias = create(&policy, "green.farm", ExpiryChoice::LeaseSeconds(None));
        {
            let service = policy.service.lock().unwrap();
            service.disable(alias.id).unwrap();
        }
        assert!(matches!(
            policy.decide("green.farm@example.com"),
            PolicyDecision::Reject(_)
        ));
    }

    #[test]
    fn storage_failure_is_temporary_not_unknown() {
        let policy = policy("2026-01-04T00:00:00Z");
        {
            let service = policy.service.lock().unwrap();
            service
                .store()
                .connection()
                .execute_batch("DROP TABLE aliases;")
                .unwrap();
        }
        assert!(matches!(
            policy.decide("green.farm@example.com"),
            PolicyDecision::Temporary(_)
        ));
    }
}
