# Wickmail

Wickmail is a self-hosted email system with programmable, expiring aliases.

The companion app generates a readable random address like `green.farm@example.com` with a chosen lease, such as seven days. Mail is delivered normally while the lease is active. When the lease expires, mail to that address is quarantined instead of reaching your inbox. Sending through the alias, or explicitly renewing it, restarts the lease. Inbound mail never extends its own lease, so a merchant cannot keep an address alive forever by continuing to email it.

## Status

Design phase. The repository currently contains the design specification and monorepo scaffold only. No implementation exists yet.

## Core rules (v1)

- Alias addresses are readable and randomly generated; they encode no expiry, ownership, or other policy.
- An alias grants a temporary lease, not a permanent address.
- Inbound mail never renews a lease.
- Authenticated outbound mail renews the lease.
- Manual renewal, extension, and absolute expiry are supported.
- Expired aliases accept mail into quarantine.
- Disabled aliases are rejected at SMTP time.
- Unknown recipients are rejected; there is no unrestricted catch-all.
- Alias addresses are never reused for a different purpose or owner.

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

## Documentation

- [Design overview](docs/design/overview.md)
- [Mail server](docs/design/mail-server.md)
- [Web management app](docs/design/web-app.md)
- [Android WebView shell](docs/design/android.md)
- [Architecture decision records](docs/decisions/README.md)

## License

AGPL-3.0. See [LICENSE](LICENSE).
