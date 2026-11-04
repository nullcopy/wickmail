# wickmail-web

Responsive web management UI and focused reply composer for Wickmail, implemented in TypeScript with React and reused by the Android WebView shell.

Scope:

- Readable random alias generation with expiration selection
- Alias dashboard with expiry and recently-used filtering and sorting
- Alias detail and management flows
- Quarantine review and recovery
- Reply-as-alias composer with provenance-based identity selection
- Activity history and settings

Consumes the Rust server's management API through the [wickmail-core](../../packages/core/README.md) client package. See [web management app design](../../docs/design/web-app.md) and [ADR 0012](../../docs/decisions/0012-rust-server-typescript-clients.md).

Status: not implemented.
