# wickmail-core

TypeScript client schemas and API client for the Wickmail web app.

Scope:

- Alias, lease, message, provenance, and reply types
- Management API request and response schemas
- API client helpers used by the web app
- Validation of API payloads

`wickmail-core` is the client package for `wickmail-web`. The Rust server owns its own types and is the source of truth for the HTTP contract; this package mirrors it. It contains no lease evaluation or policy rules: the server is authoritative, and clients consume server-computed effective state and raw timestamps rather than deriving expiry, renewal, or routing decisions. The Android shell hosts the web app and does not consume this package directly.

See the [design overview](../../docs/design/overview.md), [mail server design](../../docs/design/mail-server.md), and [ADR 0012](../../docs/decisions/0012-rust-server-typescript-clients.md).

Status: not implemented.
