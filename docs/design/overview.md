# Wickmail design overview

## Purpose

Wickmail is a self-hosted email system whose defining feature is programmable, expiring aliases. An alias grants temporary permission to deliver mail to a primary mailbox. When the lease expires, delivery stops and mail is quarantined, but the address is not destroyed. It can be renewed, extended, or reactivated when the user genuinely needs to hear from it again.

The motivating scenario is an online purchase: the companion app generates a readable random address with a chosen expiration time. The address stays valid long enough to receive receipts and support replies, then stops reaching the inbox if the merchant sells the address or keeps sending marketing mail. Replies sent from the app keep using the alias, so the primary address stays private.

## Working assumptions

- Initial deployment is single-user with one primary mailbox.
- The server generates readable random alias addresses at the app's request.
- Expiry and all other policy are stored separately from the address.
- Aliases are created before use; there is no unrestricted catch-all.
- The app generates, lists, filters, sorts, and manages aliases, recovers quarantined mail, and sends replies as an alias.
- Standard email clients read the mailbox over IMAP and can send mail, but they do not participate in alias identity selection.
- Expired mail is quarantined for 30 days by default; spam retention is configured separately.
- The web app is responsive and runs both in browsers and inside the Android WebView.
- A Nix flake is the canonical build, development, test, and deployment interface. See [ADR 0011](../decisions/0011-nix-flake-first-class.md).
- All timestamps are stored and evaluated in UTC.

## Non-goals for v1

- General webmail. The app includes a focused reply composer only.
- Alias identity selection in arbitrary email clients.
- Multiple users, organizations, or delegated alias ownership.
- User-chosen alias local parts.
- Arbitrary user code in the mail path.

## Naming

| Item                          | Name               |
| ----------------------------- | ------------------ |
| Product and repository        | Wickmail           |
| Server and management API     | `wickmail-server`  |
| Web management app            | `wickmail-web`     |
| Android shell                 | `wickmail-android` |
| Shared schemas and API client | `wickmail-core`    |

## Glossary

- **Alias:** A readable, randomly generated email address that maps to the primary mailbox and carries a lease.
- **Lease:** The period during which an alias may deliver mail to the inbox.
- **Active:** The lease has not expired and the alias is not disabled.
- **Expired:** The lease has passed; mail is quarantined at delivery.
- **Disabled:** Explicitly turned off; mail is rejected at SMTP time.
- **Renewal:** Restarting the lease relative to the current time.
- **Extension:** Adding time to an existing, unexpired lease.
- **Last used:** The later of the last inbound mail and last user activity; used for list sorting, not lease decisions.
- **Provenance:** The trusted set of aliases and the primary address that received a message, recorded from the SMTP envelope.
- **Quarantine:** Storage for mail addressed to expired aliases, recoverable by the user.
- **Recovery:** Moving a quarantined message to the inbox, optionally renewing or enabling the alias.
- **Reply alias:** The alias selected as the sending identity for a reply.

## Design principles

1. **Leases, not destruction.** The address stays valid; delivery permission changes.
2. **Addresses carry no policy.** Alias local parts are randomly selected readable words; expiry and behavior live only in stored policy.
3. **Inbound cannot renew.** Only authenticated user activity or explicit action extends a lease.
4. **No silent loss.** Mail is quarantined, not discarded, and outages cause temporary deferral rather than loss.
5. **No permanent rejection after acceptance.** Once SMTP accepts a message, alias policy routes it or defers it; it is never bounced for policy.
6. **Deterministic policy.** State is computed from stored fields; no hidden cron state is required for correctness.
7. **No catch-all provisioning.** Aliases are created through authenticated interfaces.
8. **Owner, not purpose, is permanent.** An alias is never reassigned to a different owner; it may be reused for another purchase from the same merchant or purpose.
9. **Server-authoritative policy.** Clients consume server-computed state and raw timestamps; they do not duplicate lease evaluation.
10. **Keep policy out of the mail path.** Arbitrary user code is never executed during SMTP delivery.
11. **One reproducible toolchain.** A Nix flake builds, tests, and deploys the system, and developers and CI use the same pinned derivations.

## Repository layout

```text
wickmail/
  flake.nix         # build, development, test, and deployment entry point
  apps/server/      # policy lookup, LMTP proxy, management API
  apps/web/         # responsive management UI and reply composer
  apps/android/     # Android WebView shell
  packages/core/    # shared schemas, types, and API client
  infra/            # deployment, mail config, backup scripts
  docs/design/      # design specifications
  docs/decisions/   # architecture decision records
```

## Suggested implementation sequence

The highest-risk work is the mail path and the reply path, so v1 starts with a risk-first walking skeleton rather than the management API.

0. **Flake foundation:** a `flake.nix` with pinned inputs, a dev shell, and initial `checks` for formatting and lint, so every later step is built and tested through Nix.
1. **Walking skeleton:** create alias, receive while active, expire, quarantine, recover without duplication, reply as alias, and renew.
2. **Failure injection:** policy outage, crash during recovery, retention overlapping recovery, spool exhaustion, and multiple-alias reply selection.
3. **Management API and web app:** alias generation and management, filtering and sorting, quarantine recovery, and the reply composer.
4. **Android shell:** secure WebView, navigation, copy and share, and failure handling.
5. **Operational hardening:** backups, monitoring, abuse controls, restore and reconciliation drills, and deliverability checks.

## Related documents

- [Mail server design](mail-server.md)
- [Web management app design](web-app.md)
- [Android WebView shell design](android.md)
- [Architecture decision records](../decisions/README.md)
