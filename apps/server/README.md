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

Status: not implemented.
