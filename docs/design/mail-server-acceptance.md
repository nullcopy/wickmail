# Mail server acceptance-criteria sweep

This document maps every acceptance criterion and failure-injection case in
[mail-server.md](mail-server.md) to the test or manual check that verifies it.
It is the evidence for the walking-skeleton definition of done.

## How to run

```sh
# Rust unit and integration tests.
nix develop -c bash -c 'cd apps/server && cargo test'

# Full gate, including the NixOS VM mail-path test.
nix flake check
```

The Rust tests are deterministic and cover the failure-injection cases that do
not need the real components. The NixOS VM test `mail-path` runs Postfix,
Rspamd, Dovecot, and `wickmail-server` together and exercises the real inbound
path.

## Acceptance criteria

| # | Criterion | Verification |
|---|---|---|
| 1 | Generated local parts are unique, readable dictionary words with no user-supplied or policy-derived components. | `generator::tests::default_local_part_is_two_dictionary_words`, `generated_addresses_are_canonical_and_unique_in_practice`, `retries_on_collision_then_succeeds`, `adds_a_third_word_when_two_word_space_is_exhausted`, `service::tests::create_generates_unique_addresses`. `POST /v1/aliases` accepts no local part or address. |
| 2 | Changing expiration or other policy does not change an alias's address. | `service::tests::policy_changes_never_change_an_alias_address`. |
| 3 | Alias list filtering and sorting handle expiration, no expiry, recent use, and never-used aliases deterministically. | Not implemented in the server crate; tracked by #52 (M6.5 management API). |
| 4 | Unknown and disabled recipients are rejected before acceptance; expired recipients are accepted and quarantined. | `inbound_path::policy_accepts_active_and_expired_and_rejects_disabled`, `disabled_alias_is_not_rejected_at_delivery`, `expired_alias_is_routed_to_quarantine`; NixOS VM "unknown and disabled recipients are rejected at RCPT" and "expired alias routes to Aliases/Expired". |
| 5 | Policy or database failure returns a temporary failure and never reports an unknown recipient. | `mail::policy::tests::storage_failure_is_temporary_not_unknown`, `inbound_path::policy_database_outage_at_rcpt_is_temporary_not_unknown`, `inbound_path::policy_database_outage_at_delivery_is_temporary_and_not_bounced`; NixOS VM "policy service down returns a temporary failure". |
| 6 | Mail to an active alias reaches the inbox. | `inbound_path::active_alias_is_delivered_to_the_inbox`; NixOS VM "active alias delivers to Inbox". |
| 7 | Inbound messages never extend the lease. | `inbound_path::expired_alias_is_routed_to_quarantine`, `inbound_path::a_spoofed_inbound_mail_from_does_not_renew_the_alias`, `service::tests::inbound_records_activity_without_renewing`. |
| 8 | Mail arriving at or after expiry is quarantined. | `inbound_path::expired_alias_is_routed_to_quarantine`; NixOS VM "expired alias routes to Aliases/Expired". |
| 9 | An authenticated outbound message renews an active alias when `renew_on_outbound` is true. | `reply::submission::tests::active_alias_renews_when_policy_allows`, `reply_path::fetches_context_and_submits_a_signed_reply_as_the_alias`. |
| 10 | Sending through an expired alias reactivates it only when `renew_on_outbound` is true. | `reply::submission::tests::expired_alias_reactivates_when_policy_allows`, `expired_alias_is_rejected_when_policy_disallows`; NixOS VM submission ownership check. |
| 11 | A spoofed inbound `MAIL FROM` cannot trigger renewal. | `inbound_path::a_spoofed_inbound_mail_from_does_not_renew_the_alias`. |
| 12 | Client-supplied `X-Wickmail-*` headers are stripped and cannot influence routing. | `mail::headers::tests::strips_client_wickmail_headers_case_insensitively`, `inbound_path::spoofed_wickmail_headers_are_stripped_and_replaced`; NixOS VM "spoofed X-Wickmail-* headers are stripped and replaced". |
| 13 | Disabled aliases neither receive nor send mail. | Receive: `inbound_path::policy_accepts_active_and_expired_and_rejects_disabled`, `disabled_alias_is_not_rejected_at_delivery`; NixOS VM. Send: `mail::submission::tests::rejects_disabled_and_expired_non_renewing_aliases`, `reply::submission::tests::disabled_alias_is_rejected`. |
| 14 | Recovery and retention are idempotent and crash-safe; reconciliation repairs either store. | `tests/quarantine_recovery.rs` (all cases, including crashes before and after each destructive step and a recovery racing retention). |
| 15 | Reply provenance defaults to the single receiving alias and prompts on multiple aliases. | `reply::identity::tests::one_alias_is_the_default_and_the_primary_is_offered`, `primary_plus_one_alias_defaults_to_the_alias`, `primary_only_selects_the_primary`, `multiple_aliases_prompt_and_select_nothing`, `multiple_received_prompts_even_when_one_alias_no_longer_resolves`; `reply_path::multiple_aliases_prompt_and_never_select_silently`. |
| 16 | Outbound replies use the alias as envelope sender and sole `From`, and are DKIM-aligned. | `reply::outbound` tests, `reply::dkim::tests::signature_is_dmarc_aligned`, `reply_path::fetches_context_and_submits_a_signed_reply_as_the_alias`, `a_mismatched_envelope_sender_is_rejected_before_queueing`, `multiple_from_mailboxes_are_rejected_before_queueing`, `a_mismatched_sender_header_is_rejected_before_queueing`. |
| 17 | Recovering a quarantined message does not duplicate it. | `quarantine_recovery::recovery_moves_the_message_without_duplicating`, `crash_between_copy_and_delete_keeps_the_inbox_copy`; NixOS VM recovery step. |
| 18 | No accepted message is permanently rejected or bounced for alias policy. | `inbound_path::disabled_alias_is_not_rejected_at_delivery`, `spool_worker_retries_until_dovecot_is_available`, `an_unavailable_spool_returns_temporary_before_acceptance`, `a_corrupt_spool_entry_does_not_block_later_deliveries`. |

## Failure-injection matrix

| Case | Verification |
|---|---|
| Policy or database outage at RCPT | `inbound_path::policy_database_outage_at_rcpt_is_temporary_not_unknown`; NixOS VM. |
| Policy or database outage at delivery | `inbound_path::policy_database_outage_at_delivery_is_temporary_and_not_bounced`. |
| Crash during recovery before the inbox copy | `quarantine_recovery::crash_before_the_inbox_copy_returns_to_quarantined`. |
| Crash during recovery between copy and delete | `quarantine_recovery::crash_between_copy_and_delete_keeps_the_inbox_copy`. |
| Crash during recovery after delete | `quarantine_recovery::crash_after_delete_before_mark_completes_on_reconcile`. |
| Crash during retention before body deletion | `quarantine_recovery::retention_crash_before_body_delete_repairs`. |
| Crash during retention after body deletion | `quarantine_recovery::retention_crash_after_body_delete_repairs`. |
| Retention running while recovery is in flight | `quarantine_recovery::retention_skips_recovery_in_flight`, `retention_never_deletes_deleting_metadata`. |
| Spool full | `inbound_path::full_spool_returns_a_temporary_failure` (asserts the exhaustion counter). |
| Spool unavailable | `inbound_path::an_unavailable_spool_returns_temporary_before_acceptance`. |
| Dovecot unavailable | `inbound_path::spool_worker_retries_until_dovecot_is_available` (the message stays in the spool, retries, and is delivered without a bounce). |
| Multiple-alias provenance | `inbound_path::multiple_alias_provenance_records_every_receiving_alias`, `reply_path::multiple_aliases_prompt_and_never_select_silently`. |
| Primary-plus-alias provenance | `inbound_path::multiple_alias_provenance_records_every_receiving_alias`, `reply::identity::tests::primary_plus_one_alias_defaults_to_the_alias`. |
| Reply identity mismatch and multiple `From` | `reply::outbound` tests, `reply_path::a_mismatched_envelope_sender_is_rejected_before_queueing`, `multiple_from_mailboxes_are_rejected_before_queueing`, `a_mismatched_sender_header_is_rejected_before_queueing`. |
| Address canonicalization and case-insensitive lookup | `address::tests::*`, `inbound_path::lookup_is_case_insensitive_and_plus_tags_do_not_match`, `db::tests::enforces_address_uniqueness_on_canonical_form`. |

## Observability

`MailPath` exposes counters for policy failures, spool exhaustion, spool
unavailability, forwarding failures, accepted messages, and delivered messages.
The running server logs them alongside spool depth and age, which is the alert
signal for spool exhaustion. A Prometheus endpoint and alert rules are tracked
by #69 (M9.2 monitoring and alerting).

## Out of scope for the walking skeleton

These criteria from the design are operational and are tracked by later
milestones:

- Alias list filtering and sorting: #52.
- Quotas, rate limits, and disk-full behavior at the API: #54, #72.
- SPF, DKIM, DMARC, reverse DNS, and TLS deployment checks: #70.
- Backup, restore, and reconciliation drills: #68.
- Prometheus metrics and alert rules: #69.
