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

Status: not implemented.
