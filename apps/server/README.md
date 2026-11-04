# wickmail-server

Policy lookup, LMTP proxy, lease engine, and management API for Wickmail.

Scope:

- Readable random alias generation and canonical lookup
- RCPT-time recipient validation and delivery-time lease evaluation
- LMTP proxy with trusted headers and a durable spool
- Alias list filtering, sorting, and management
- Quarantine metadata, recovery, reconciliation, and retention
- Inbound provenance and reply-as-alias outbound identity
- Management API used by the web and Android clients
- Authentication, bootstrap, API tokens, and abuse controls

See [mail server design](../../docs/design/mail-server.md) and the [architecture decision records](../../docs/decisions/README.md).

## Storage

SQLite runs with write-ahead logging, foreign keys, and a busy timeout. Versioned migrations apply forward and revert cleanly. Timestamps are stored as epoch milliseconds in UTC and evaluated at request time; there is no scheduler state.

The driver is [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3), chosen because its prebuilt binaries install and load under the Nix-provided Node.js 22 in this repository, and its synchronous API keeps the single-owner write path simple. If a future environment cannot install or load the native module, the fallback is Node's built-in `node:sqlite`, which on Node 22 requires the `--experimental-sqlite` flag and emits an experimental warning. The database layer is isolated in `src/db` so the driver can be swapped without touching the lease or alias logic.

## Status

In progress. The alias core service (M1) is implemented: schemas and types live in [`wickmail-core`](../../packages/core), and this package provides the SQLite schema and migrations, the readable random alias generator, canonicalization and case-insensitive lookup, lease evaluation, and lifecycle audit events. The mail path, management API, and UI are not implemented yet.
