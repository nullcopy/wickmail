# wickmail-server

Policy lookup, LMTP proxy, lease engine, and management API for Wickmail, implemented in Rust.

Scope:

- Readable random alias generation and canonical lookup
- RCPT-time recipient validation and delivery-time lease evaluation
- LMTP proxy with trusted headers and a durable spool
- Alias list filtering, sorting, and management
- Quarantine metadata, recovery, reconciliation, and retention
- Inbound provenance and reply-as-alias outbound identity
- Management API used by the web and Android clients
- Authentication, bootstrap, API tokens, and abuse controls

Built with Cargo and packaged by the Nix flake. See [mail server design](../../docs/design/mail-server.md), [ADR 0012](../../docs/decisions/0012-rust-server-typescript-clients.md), and the [architecture decision records](../../docs/decisions/README.md).

## Alias core (M1)

The crate currently provides the alias core that the mail path and API build on:

- `address`: canonical address parsing (lowercase ASCII local part, lowercase
  ASCII or punycode domain) with case-insensitive equality. Plus addressing is
  unsupported.
- `generator`: readable random local parts from a curated word list, selected
  with the OS CSPRNG and retried on collision.
- `alias`, `message`, `timestamp`, `clock`: domain types and a testable clock.
- `lease`: effective state and the outbound and manual-action truth tables.
- `audit`: lifecycle events, structured detail, and retention constants.
- `db`: the SQLite schema with versioned forward-and-revert migrations, plus
  WAL, foreign keys, and a busy timeout.
- `service`: `AliasService`, which combines generation, storage, lease
  evaluation, and audit recording.
- `api` and `contract`: the management API request and response shapes and the
  JSON fixtures the TypeScript client validates.

The `wickmail-server` binary reports its version and can apply migrations:

```text
wickmail-server migrate <database>
```

Run the tests with `nix develop -c cargo test -p wickmail-server`.
