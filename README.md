# Wickmail

Wickmail is a self-hosted email system with programmable, expiring aliases.

The companion app generates a readable random address like `green.farm@example.com` with a chosen lease, such as seven days. Mail is delivered normally while the lease is active. When the lease expires, mail to that address is quarantined instead of reaching your inbox. Sending through the alias, or explicitly renewing it, restarts the lease. Inbound mail never extends its own lease, so a merchant cannot keep an address alive forever by continuing to email it. Replies sent from the app use the receiving alias, so your primary address stays private.

## Repository layout

```text
wickmail/
  flake.nix         # build, development, test, and deployment entry point
  apps/server/      # Rust alias service, policy engine, management API
  apps/web/         # TypeScript and React management UI
  apps/android/     # Kotlin Android WebView shell
  packages/core/    # TypeScript client schemas, types, and API client
  infra/            # deployment, mail config, backup scripts
  docs/design/      # design specifications
  docs/decisions/   # architecture decision records
```

## Building and development

Wickmail is built, tested, and deployed through a Nix flake. Development uses `nix develop`, checks run with `nix flake check`, and deployment uses the flake's NixOS modules and packages. The server is written in Rust; the web app is TypeScript with React. See [ADR 0011](docs/decisions/0011-nix-flake-first-class.md) and [ADR 0012](docs/decisions/0012-rust-server-typescript-clients.md).

## Documentation

- [Design overview](docs/design/overview.md)
- [Mail server](docs/design/mail-server.md)
- [Web management app](docs/design/web-app.md)
- [Android WebView shell](docs/design/android.md)
- [Architecture decision records](docs/decisions/README.md)

## License

AGPL-3.0. See [LICENSE](LICENSE).
