# Wickmail

Wickmail is a self-hosted email system with programmable, expiring aliases.

The companion app generates a readable random address like `green.farm@example.com` with a chosen lease, such as seven days. Mail is delivered normally while the lease is active. When the lease expires, mail to that address is quarantined instead of reaching your inbox. Sending through the alias, or explicitly renewing it, restarts the lease. Inbound mail never extends its own lease, so a merchant cannot keep an address alive forever by continuing to email it. Replies sent from the app use the receiving alias, so your primary address stays private.

## Repository layout

```text
wickmail/
  flake.nix         # build, development, test, and deployment entry point
  apps/server/      # Rust alias service, policy engine, management API
  apps/web/         # TypeScript and Svelte management UI
  apps/android/     # Kotlin Android WebView shell
  packages/core/    # TypeScript client schemas, types, and API client
  infra/            # deployment, mail config, backup scripts
  docs/design/      # design specifications
  docs/decisions/   # architecture decision records
```

## Building and development

Wickmail is built, tested, and deployed through a Nix flake. The server is written in Rust; the web app is TypeScript with Svelte. See [ADR 0011](docs/decisions/0011-nix-flake-first-class.md), [ADR 0012](docs/decisions/0012-rust-server-typescript-clients.md), and [ADR 0013](docs/decisions/0013-typescript-svelte-web-app.md).

```sh
nix develop                  # shell with the Rust, Node, and mail toolchains
nix flake check              # format, lint, and test everything
nix build .#wickmail-server  # build the Rust server
nix build .#wickmail-web     # build the web app
nix run .#server             # run the server
nix fmt                      # format flake.nix and the Nix modules
```

Formatting is fixed from inside the dev shell:

```sh
cargo fmt --all    # Rust (from apps/server)
npm run format     # TypeScript, Svelte, and config files
```

CI runs `nix flake check` on pull requests and on `main`.

## Documentation

- [Design overview](docs/design/overview.md)
- [Mail server](docs/design/mail-server.md)
- [Web management app](docs/design/web-app.md)
- [Android WebView shell](docs/design/android.md)
- [Architecture decision records](docs/decisions/README.md)

## License

AGPL-3.0. See [LICENSE](LICENSE).
