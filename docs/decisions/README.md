# Architecture decision records

Wickmail records architecturally significant decisions using the format described by Michael Nygard in [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).

Each record contains:

- **Title:** a short noun phrase
- **Status:** proposed, accepted, deprecated, or superseded
- **Context:** the forces and constraints behind the decision
- **Decision:** the chosen response, stated in active voice
- **Consequences:** positive, negative, and neutral results

Records are numbered sequentially and monotonically. Numbers are never reused. A reversed decision remains in the log and is marked superseded with a reference to its replacement.

## Log

| Record | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-keep-alias-addresses-opaque.md) | Keep alias addresses opaque and separate from policy | Superseded by [0005](0005-generate-readable-random-aliases.md) |
| [0003](0003-renew-leases-only-through-user-activity.md) | Renew leases only through authenticated user activity | Accepted |
| [0004](0004-quarantine-mail-for-expired-aliases.md) | Quarantine mail for expired aliases | Accepted |
| [0005](0005-generate-readable-random-aliases.md) | Generate readable random aliases | Accepted |
