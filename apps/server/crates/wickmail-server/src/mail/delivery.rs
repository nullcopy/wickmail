//! Delivery-time planning: recipient classification, route, and provenance.
//!
//! The proxy evaluates every envelope recipient when the message is delivered.
//! The result is a single trusted route for the message and the set of aliases
//! that received it. A message accepted at RCPT is never permanently rejected
//! here; unknown or disabled recipients are quarantined.

use crate::address::CanonicalAddress;
use crate::alias::{AliasId, AliasState};
use crate::mail::policy::{PolicyError, RecipientKind};
use crate::message::{MessageId, Route};

/// The outcome of evaluating a message's envelope recipients.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedDelivery {
    /// Stable identity for the delivered message.
    pub message_id: MessageId,
    /// Trusted route.
    pub route: Route,
    /// Aliases that received the message, in envelope order, deduplicated.
    pub alias_ids: Vec<AliasId>,
    /// Whether the primary address received the message.
    pub primary_received: bool,
    /// Recipients that matched neither the primary address nor a known alias.
    pub unknown: Vec<CanonicalAddress>,
}

/// Plans delivery for a set of canonical envelope recipients.
///
/// Spam is routed to `Spam` regardless of alias state. Otherwise, if any
/// recipient alias is expired or disabled the message is quarantined; a
/// message to the primary address or an active alias goes to `Inbox`.
pub fn plan<F>(
    recipients: &[CanonicalAddress],
    spam: bool,
    mut resolve: F,
) -> Result<PlannedDelivery, PolicyError>
where
    F: FnMut(&CanonicalAddress) -> Result<RecipientKind, PolicyError>,
{
    let mut alias_ids = Vec::new();
    let mut primary_received = false;
    let mut any_quarantined = false;
    let mut unknown = Vec::new();

    for recipient in recipients {
        match resolve(recipient)? {
            RecipientKind::Primary => primary_received = true,
            RecipientKind::Alias { id, state } => {
                if !alias_ids.contains(&id) {
                    alias_ids.push(id);
                }
                if matches!(state, AliasState::Expired | AliasState::Disabled) {
                    any_quarantined = true;
                }
            }
            RecipientKind::Unknown => {
                if !unknown.contains(recipient) {
                    unknown.push(recipient.clone());
                }
            }
        }
    }

    let route = if spam {
        Route::Spam
    } else if any_quarantined || (!primary_received && alias_ids.is_empty()) {
        Route::Quarantine
    } else {
        Route::Inbox
    };

    Ok(PlannedDelivery {
        message_id: MessageId::new(),
        route,
        alias_ids,
        primary_received,
        unknown,
    })
}

#[cfg(test)]
mod tests {
    use super::plan;
    use crate::address::CanonicalAddress;
    use crate::alias::{AliasId, AliasState};
    use crate::mail::policy::{PolicyError, RecipientKind};
    use crate::message::Route;

    fn address(value: &str) -> CanonicalAddress {
        CanonicalAddress::parse(value).unwrap()
    }

    fn alias(value: &str) -> AliasId {
        AliasId::from_uuid(value.parse().unwrap())
    }

    fn resolver(
        entries: Vec<(CanonicalAddress, RecipientKind)>,
    ) -> impl FnMut(&CanonicalAddress) -> Result<RecipientKind, PolicyError> {
        move |address: &CanonicalAddress| {
            Ok(entries
                .iter()
                .find(|(candidate, _)| candidate == address)
                .map(|(_, kind)| *kind)
                .unwrap_or(RecipientKind::Unknown))
        }
    }

    #[test]
    fn active_alias_routes_to_inbox() {
        let id = alias("018f9b60-0000-7000-8000-000000000001");
        let plan = plan(
            &[address("green.farm@example.com")],
            false,
            resolver(vec![(
                address("green.farm@example.com"),
                RecipientKind::Alias {
                    id,
                    state: AliasState::Active,
                },
            )]),
        )
        .unwrap();
        assert_eq!(plan.route, Route::Inbox);
        assert_eq!(plan.alias_ids, vec![id]);
        assert!(!plan.primary_received);
    }

    #[test]
    fn expired_alias_routes_to_quarantine() {
        let id = alias("018f9b60-0000-7000-8000-000000000002");
        let plan = plan(
            &[address("old.farm@example.com")],
            false,
            resolver(vec![(
                address("old.farm@example.com"),
                RecipientKind::Alias {
                    id,
                    state: AliasState::Expired,
                },
            )]),
        )
        .unwrap();
        assert_eq!(plan.route, Route::Quarantine);
    }

    #[test]
    fn spam_wins_over_quarantine() {
        let id = alias("018f9b60-0000-7000-8000-000000000003");
        let plan = plan(
            &[address("old.farm@example.com")],
            true,
            resolver(vec![(
                address("old.farm@example.com"),
                RecipientKind::Alias {
                    id,
                    state: AliasState::Expired,
                },
            )]),
        )
        .unwrap();
        assert_eq!(plan.route, Route::Spam);
    }

    #[test]
    fn primary_and_alias_share_one_delivery() {
        let id = alias("018f9b60-0000-7000-8000-000000000004");
        let plan = plan(
            &[
                address("user@example.com"),
                address("green.farm@example.com"),
            ],
            false,
            resolver(vec![
                (address("user@example.com"), RecipientKind::Primary),
                (
                    address("green.farm@example.com"),
                    RecipientKind::Alias {
                        id,
                        state: AliasState::Active,
                    },
                ),
            ]),
        )
        .unwrap();
        assert_eq!(plan.route, Route::Inbox);
        assert!(plan.primary_received);
        assert_eq!(plan.alias_ids, vec![id]);
    }

    #[test]
    fn unknown_recipients_are_quarantined_not_rejected() {
        let plan = plan(&[address("nobody@example.com")], false, resolver(vec![])).unwrap();
        assert_eq!(plan.route, Route::Quarantine);
        assert_eq!(plan.unknown, vec![address("nobody@example.com")]);
    }
}
