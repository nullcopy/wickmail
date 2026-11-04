# wickmail-core

TypeScript client schemas and API client for the Wickmail web app.

Scope:

- Alias, lease, message, provenance, and reply types
- Management API request and response schemas
- API client helpers used by the web app
- Validation of API payloads

`wickmail-core` is the client package for `wickmail-web`. The Rust server owns its own types and is the source of truth for the HTTP contract; this package mirrors it. It contains no lease evaluation or policy rules: the server is authoritative, and clients consume server-computed effective state and raw timestamps rather than deriving expiry, renewal, or routing decisions. The Android shell hosts the web app and does not consume this package directly.

See the [design overview](../../docs/design/overview.md), [mail server design](../../docs/design/mail-server.md), and [ADR 0012](../../docs/decisions/0012-rust-server-typescript-clients.md) and [ADR 0013](../../docs/decisions/0013-typescript-svelte-web-app.md).

## Schemas and validation (M1)

- `contract.ts` defines the client-facing types that mirror the Rust management
  API: aliases, lease settings, audit events, provenance, and replies.
- `validate.ts` provides strict runtime validation for those payloads.
  Unknown properties are rejected, so an added or renamed server field fails
  validation until this package is updated.
- `index.ts` re-exports both modules and the contract version.

Drift is guarded by the fixtures under
`apps/server/crates/wickmail-server/fixtures`, which the Rust crate generates
from its own types. `validate.test.ts` validates every fixture and checks that
the client and server contract versions agree.

Run the tests with `nix develop -c npm run test --workspace=@wickmail/core` and
the type check with `nix develop -c npm run check --workspace=@wickmail/core`.
