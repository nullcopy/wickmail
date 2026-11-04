//! Provenance-based reply identity selection.
//!
//! The default reply identity comes from trusted provenance: the alias that
//! received the message. Exactly one receiving alias is selected by default,
//! with the primary address offered as an alternative. A primary-only message
//! selects the primary identity. When several aliases received the message the
//! server selects nothing and the client must prompt.

use crate::address::CanonicalAddress;
use crate::alias::Alias;
use crate::api::{ReplyIdentityDecision, ReplyIdentityOption, ReplyIdentitySelection};
use crate::message::Provenance;

/// Selects the reply identity for `provenance`.
///
/// `aliases` are the owned aliases named by provenance, in provenance order,
/// with any alias that no longer resolves already removed. `primary` is the
/// account's primary address when one is configured.
pub fn select_reply_identity(
    provenance: &Provenance,
    aliases: &[Alias],
    primary: Option<&CanonicalAddress>,
) -> ReplyIdentityDecision {
    let alias_options: Vec<ReplyIdentityOption> = aliases
        .iter()
        .map(|alias| ReplyIdentityOption::Alias {
            alias_id: alias.id,
            address: alias.address.clone(),
        })
        .collect();
    let primary_option = primary.map(|address| ReplyIdentityOption::Primary {
        address: address.clone(),
    });

    if alias_options.is_empty() {
        if provenance.primary_received {
            if let Some(primary) = primary_option {
                return ReplyIdentityDecision {
                    selection: ReplyIdentitySelection::Default,
                    selected: Some(primary.clone()),
                    options: vec![primary],
                };
            }
        }
        return ReplyIdentityDecision {
            selection: ReplyIdentitySelection::Prompt,
            selected: None,
            options: primary_option.into_iter().collect(),
        };
    }

    if let [alias] = alias_options.as_slice() {
        let mut options = vec![alias.clone()];
        if let Some(primary) = primary_option {
            options.push(primary);
        }
        return ReplyIdentityDecision {
            selection: ReplyIdentitySelection::Default,
            selected: Some(alias.clone()),
            options,
        };
    }

    let mut options = alias_options;
    if let Some(primary) = primary_option {
        options.push(primary);
    }
    ReplyIdentityDecision {
        selection: ReplyIdentitySelection::Prompt,
        selected: None,
        options,
    }
}

#[cfg(test)]
mod tests {
    use super::select_reply_identity;
    use crate::address::CanonicalAddress;
    use crate::alias::{Alias, AliasId, DEFAULT_LEASE_SECONDS};
    use crate::api::{ReplyIdentityOption, ReplyIdentitySelection};
    use crate::message::Provenance;
    use crate::timestamp::Timestamp;

    fn alias(id: &str, address: &str) -> Alias {
        Alias {
            id: AliasId::from_uuid(id.parse().unwrap()),
            address: CanonicalAddress::parse(address).unwrap(),
            label: None,
            purpose: None,
            created_at: "2026-01-01T00:00:00Z".parse::<Timestamp>().unwrap(),
            expires_at: None,
            disabled_at: None,
            lease_duration_seconds: DEFAULT_LEASE_SECONDS,
            renew_on_outbound: true,
            last_inbound_at: None,
            last_user_activity_at: None,
            policy_version: 0,
        }
    }

    fn primary() -> CanonicalAddress {
        CanonicalAddress::parse("me@example.com").unwrap()
    }

    const ID_A: &str = "018f9b60-0000-7000-8000-00000000000a";
    const ID_B: &str = "018f9b60-0000-7000-8000-00000000000b";

    #[test]
    fn one_alias_is_the_default_and_the_primary_is_offered() {
        let first = alias(ID_A, "green.farm@example.com");
        let decision = select_reply_identity(
            &Provenance {
                alias_ids: vec![first.id],
                primary_received: false,
            },
            std::slice::from_ref(&first),
            Some(&primary()),
        );
        assert_eq!(decision.selection, ReplyIdentitySelection::Default);
        assert_eq!(
            decision.selected,
            Some(ReplyIdentityOption::Alias {
                alias_id: first.id,
                address: first.address.clone(),
            })
        );
        assert_eq!(decision.options.len(), 2);
        assert_eq!(
            decision.options[1],
            ReplyIdentityOption::Primary { address: primary() }
        );
    }

    #[test]
    fn primary_only_selects_the_primary() {
        let decision = select_reply_identity(
            &Provenance {
                alias_ids: Vec::new(),
                primary_received: true,
            },
            &[],
            Some(&primary()),
        );
        assert_eq!(decision.selection, ReplyIdentitySelection::Default);
        assert_eq!(
            decision.selected,
            Some(ReplyIdentityOption::Primary { address: primary() })
        );
    }

    #[test]
    fn primary_plus_one_alias_defaults_to_the_alias() {
        let first = alias(ID_A, "green.farm@example.com");
        let decision = select_reply_identity(
            &Provenance {
                alias_ids: vec![first.id],
                primary_received: true,
            },
            std::slice::from_ref(&first),
            Some(&primary()),
        );
        assert_eq!(
            decision.selected,
            Some(ReplyIdentityOption::Alias {
                alias_id: first.id,
                address: first.address.clone(),
            })
        );
    }

    #[test]
    fn multiple_aliases_prompt_and_select_nothing() {
        let first = alias(ID_A, "green.farm@example.com");
        let second = alias(ID_B, "blue.sky@example.com");
        let decision = select_reply_identity(
            &Provenance {
                alias_ids: vec![first.id, second.id],
                primary_received: true,
            },
            &[first, second],
            Some(&primary()),
        );
        assert_eq!(decision.selection, ReplyIdentitySelection::Prompt);
        assert_eq!(decision.selected, None);
        assert_eq!(decision.options.len(), 3);
    }

    #[test]
    fn primary_not_received_prompts_when_no_alias_resolves() {
        let decision = select_reply_identity(
            &Provenance {
                alias_ids: Vec::new(),
                primary_received: false,
            },
            &[],
            Some(&primary()),
        );
        assert_eq!(decision.selection, ReplyIdentitySelection::Prompt);
        assert_eq!(decision.selected, None);
    }
}
