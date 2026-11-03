# Wickmail design overview

## Purpose

Wickmail is a self-hosted email system whose defining feature is programmable, expiring aliases. An alias grants temporary permission to deliver mail to a primary mailbox. When the lease expires, delivery stops and mail is quarantined, but the address is not destroyed. It can be renewed, extended, or reactivated when the user genuinely needs to hear from it again.

The motivating scenario is an online purchase: the companion app generates a random address with a chosen expiration time. The address stays valid long enough to receive receipts and support replies, then stops reaching the inbox if the merchant sells the address or keeps sending marketing mail.

## Working assumptions

- Initial deployment is single-user with one primary mailbox.
- The server generates readable random alias addresses at the app's request.
- Expiry and all other policy are stored separately from the address.
- Aliases are created before use; there is no unrestricted catch-all.
- The apps generate, list, filter, sort, and manage aliases and quarantined mail but are not email clients.
- Standard email clients access the mailbox through IMAP/SMTP.
- Expired mail is quarantined for 30 days by default.
- The web app is responsive and runs both in browsers and inside the Android WebView.
- All timestamps are stored and evaluated in UTC.

## Naming

| Item | Name |
|---|---|
| Product and repository | Wickmail |
| Server and management API | `wickmail-server` |
| Web management app | `wickmail-web` |
| Android shell | `wickmail-android` |
| Shared types and policy package | `wickmail-core` |

## Glossary

- **Alias:** A readable, randomly generated email address that maps to the primary mailbox and carries a lease.
- **Lease:** The period during which an alias may deliver mail to the inbox.
- **Active:** The lease has not expired and the alias is not disabled.
- **Expired:** The lease has passed; mail is quarantined.
- **Disabled:** Explicitly turned off; mail is rejected at SMTP time.
- **Renewal:** Restarting the lease relative to the current time.
- **Extension:** Adding time to an existing, unexpired lease.
- **Last used:** The later of the last inbound mail and last user activity; used for list sorting, not lease decisions.
- **Quarantine:** Storage for mail addressed to expired aliases, recoverable by the user.
- **Recovery:** Moving a quarantined message to the inbox, optionally renewing the alias.

## Design principles

1. **Leases, not destruction.** The address stays valid; delivery permission changes.
2. **Addresses carry no policy.** Alias local parts are randomly selected readable words; expiry and behavior live only in stored policy.
3. **Inbound cannot renew.** Only authenticated user activity or explicit action extends a lease.
4. **No silent loss.** Mail is quarantined, not discarded, and outages cause temporary deferral rather than loss.
5. **Deterministic policy.** State is computed from stored fields; no hidden cron state is required for correctness.
6. **No catch-all provisioning.** Aliases are created through authenticated interfaces.
7. **Never reuse an address.** Disable or archive aliases instead of reassigning them.
8. **Keep policy out of the mail path.** Arbitrary user code is never executed during SMTP delivery.

## Repository layout

```text
wickmail/
  apps/server/      # alias service, policy engine, management API
  apps/web/         # responsive management UI
  apps/android/     # Android WebView shell
  packages/core/    # shared types, policy rules, API client
  infra/            # deployment, mail config, backup scripts
  docs/design/      # design specifications
  docs/decisions/   # architecture decision records
```

## Suggested implementation sequence

1. **Alias service and API:** readable random address generation, data model, lease evaluation, list filtering and sorting, authentication, and tests.
2. **Mail integration:** inbound delivery, quarantine, outbound ownership, and renewal.
3. **Responsive web app:** complete generate, browse, renew, disable, and recovery flows.
4. **Android shell:** secure WebView, navigation, copy/share, and failure handling.
5. **Operational hardening:** backups, monitoring, abuse controls, recovery testing, and deliverability checks.

This order validates the policy model and mail behavior before investing in platform-specific UI work.

## Related documents

- [Mail server design](mail-server.md)
- [Web management app design](web-app.md)
- [Android WebView shell design](android.md)
- [Architecture decision records](../decisions/README.md)
