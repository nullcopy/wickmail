# Wickmail

Wickmail is a self-hosted email system with programmable, expiring aliases.

The companion app generates a readable random address like `green.farm@example.com` with a chosen lease, such as seven days. Mail is delivered normally while the lease is active. When the lease expires, mail to that address is quarantined instead of reaching your inbox. Sending through the alias, or explicitly renewing it, restarts the lease. Inbound mail never extends its own lease, so a merchant cannot keep an address alive forever by continuing to email it.

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
