# wickmail-core

Shared schemas, types, and API client helpers for Wickmail.

Scope:

- Alias, lease, message, and provenance types
- Management API request and response schemas
- API client helpers for the web app
- Validation of API payloads

`wickmail-core` does not contain lease evaluation or policy rules. The server is authoritative: clients consume server-computed effective state and raw timestamps and never derive expiry, renewal, or routing decisions themselves. The Android shell hosts the web app and does not consume this package.

See the [design overview](../../docs/design/overview.md) and [mail server design](../../docs/design/mail-server.md).

Status: not implemented.
