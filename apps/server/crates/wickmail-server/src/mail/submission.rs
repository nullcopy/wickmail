//! Outbound submission ownership check.
//!
//! Postfix authenticated submission consults this policy through a socketmap:
//! `check_sender_access socketmap:unix:...:wickmail-submission`. The policy
//! accepts the primary address and any owned alias whose lease permits
//! outbound mail. It never renews a lease; renewal happens only after the
//! reply path accepts and queues a message.

use std::sync::{Arc, Mutex};

use crate::address::{AddressError, CanonicalAddress};
use crate::lease::{OutboundDecision, evaluate_outbound};
use crate::mail::policy::PolicyDecision;
use crate::service::AliasService;

/// The socketmap name Postfix sends for outbound sender lookups.
pub const SUBMISSION_SOCKETMAP_NAME: &str = "wickmail-submission";

/// Resolves an authenticated envelope sender against owned identities.
pub struct SubmissionPolicy {
    primary: CanonicalAddress,
    service: Arc<Mutex<AliasService>>,
}

impl SubmissionPolicy {
    /// Creates a policy over the primary address and a shared service.
    pub fn new(primary: CanonicalAddress, service: Arc<Mutex<AliasService>>) -> Self {
        Self { primary, service }
    }

    /// The primary address.
    pub fn primary(&self) -> &CanonicalAddress {
        &self.primary
    }

    /// Decides whether a raw envelope sender may submit mail.
    ///
    /// The primary address and owned aliases are accepted when the lease
    /// permits outbound mail. Unknown senders are rejected permanently; a
    /// storage failure returns a temporary failure.
    pub fn decide(&self, raw: &str) -> PolicyDecision {
        let address = match CanonicalAddress::parse(raw) {
            Ok(address) => address,
            Err(AddressError::MissingSeparator | AddressError::EmptyPart) => {
                return PolicyDecision::Reject("sender is not an owned address".to_string());
            }
            Err(error) => return PolicyDecision::Reject(error.to_string()),
        };
        if address == self.primary {
            return PolicyDecision::Accept;
        }
        let service = self.service.lock().expect("submission lock poisoned");
        let alias = match service.store().get_alias_by_address(&address) {
            Ok(alias) => alias,
            Err(error) => return PolicyDecision::Temporary(error.to_string()),
        };
        let Some(alias) = alias else {
            return PolicyDecision::Reject("sender is not an owned address".to_string());
        };
        match evaluate_outbound(&alias, service.now()) {
            OutboundDecision::RejectDisabled => {
                PolicyDecision::Reject("sender alias is disabled".to_string())
            }
            OutboundDecision::RejectExpired => PolicyDecision::Reject(
                "sender alias is expired and does not renew on outbound".to_string(),
            ),
            OutboundDecision::AcceptRenew | OutboundDecision::AcceptUnchanged => {
                PolicyDecision::Accept
            }
        }
    }

    /// Builds the socketmap reply for a request payload.
    pub fn reply_for(&self, name: &str, payload: &[u8]) -> String {
        let text = String::from_utf8_lossy(payload);
        let (map_name, key) = text.split_once(' ').unwrap_or((text.as_ref(), ""));
        if map_name != name {
            return "NOTFOUND".to_string();
        }
        match self.decide(key) {
            PolicyDecision::Accept => "OK OK".to_string(),
            PolicyDecision::Reject(reason) => format!("OK REJECT {reason}"),
            PolicyDecision::Temporary(reason) => format!("TEMP {reason}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{SUBMISSION_SOCKETMAP_NAME, SubmissionPolicy};
    use crate::address::{CanonicalAddress, Domain};
    use crate::alias::{Alias, AliasId, DEFAULT_LEASE_SECONDS};
    use crate::clock::FixedClock;
    use crate::db::Store;
    use crate::generator::AliasGenerator;
    use crate::mail::policy::PolicyDecision;
    use crate::service::AliasService;
    use crate::timestamp::Timestamp;
    use std::sync::{Arc, Mutex};

    fn at(value: &str) -> Timestamp {
        value.parse().unwrap()
    }

    fn policy(now: &str) -> SubmissionPolicy {
        let mut store = Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        let service = AliasService::new(
            store,
            AliasGenerator::new(),
            Domain::parse("example.com").unwrap(),
            Arc::new(FixedClock::new(at(now))),
        );
        SubmissionPolicy::new(
            CanonicalAddress::parse("user@example.com").unwrap(),
            Arc::new(Mutex::new(service)),
        )
    }

    fn insert(
        policy: &SubmissionPolicy,
        address: &str,
        expires_at: Option<Timestamp>,
        renew: bool,
    ) {
        let alias = Alias {
            id: AliasId::new(),
            address: CanonicalAddress::parse(address).unwrap(),
            label: None,
            purpose: None,
            created_at: at("2026-01-01T00:00:00Z"),
            expires_at,
            disabled_at: None,
            lease_duration_seconds: DEFAULT_LEASE_SECONDS,
            renew_on_outbound: renew,
            last_inbound_at: None,
            last_user_activity_at: None,
            policy_version: 0,
        };
        policy
            .service
            .lock()
            .unwrap()
            .store()
            .insert_alias(&alias)
            .unwrap();
    }

    #[test]
    fn accepts_the_primary_and_active_aliases() {
        let policy = policy("2026-01-04T00:00:00Z");
        insert(
            &policy,
            "green.farm@example.com",
            Some(at("2026-01-08T00:00:00Z")),
            true,
        );
        assert_eq!(policy.decide("user@example.com"), PolicyDecision::Accept);
        assert_eq!(
            policy.decide("green.farm@example.com"),
            PolicyDecision::Accept
        );
    }

    #[test]
    fn rejects_unknown_senders() {
        let policy = policy("2026-01-04T00:00:00Z");
        assert!(matches!(
            policy.decide("nobody@example.com"),
            PolicyDecision::Reject(_)
        ));
    }

    #[test]
    fn rejects_disabled_and_expired_non_renewing_aliases() {
        let policy = policy("2026-01-04T00:00:00Z");
        insert(
            &policy,
            "off.farm@example.com",
            Some(at("2026-01-08T00:00:00Z")),
            true,
        );
        insert(
            &policy,
            "old.farm@example.com",
            Some(at("2026-01-02T00:00:00Z")),
            false,
        );
        {
            let service = policy.service.lock().unwrap();
            let alias = service
                .store()
                .get_alias_by_address(&CanonicalAddress::parse("off.farm@example.com").unwrap())
                .unwrap()
                .unwrap();
            service.disable(alias.id).unwrap();
        }
        assert!(matches!(
            policy.decide("off.farm@example.com"),
            PolicyDecision::Reject(_)
        ));
        assert!(matches!(
            policy.decide("old.farm@example.com"),
            PolicyDecision::Reject(_)
        ));
    }

    #[test]
    fn accepts_an_expired_alias_that_renews() {
        let policy = policy("2026-01-04T00:00:00Z");
        insert(
            &policy,
            "old.farm@example.com",
            Some(at("2026-01-02T00:00:00Z")),
            true,
        );
        assert_eq!(
            policy.decide("old.farm@example.com"),
            PolicyDecision::Accept
        );
    }

    #[test]
    fn reply_uses_the_socketmap_protocol() {
        let policy = policy("2026-01-04T00:00:00Z");
        assert_eq!(
            policy.reply_for(
                SUBMISSION_SOCKETMAP_NAME,
                b"wickmail-submission user@example.com"
            ),
            "OK OK"
        );
        assert_eq!(
            policy.reply_for(
                SUBMISSION_SOCKETMAP_NAME,
                b"wickmail-submission nobody@example.com"
            ),
            "OK REJECT sender is not an owned address"
        );
        assert_eq!(
            policy.reply_for(SUBMISSION_SOCKETMAP_NAME, b"other user@example.com"),
            "NOTFOUND"
        );
    }
}
