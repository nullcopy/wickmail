# 10. Use SQLite for single-user v1

## Status

Accepted

## Context

The v1 deployment is single-user with one primary mailbox. The alias database stores alias definitions, lease policy, provenance, quarantine metadata, audit events, and API tokens. The management API and the policy and LMTP services can run as one process. A separate database server adds operational work without a concrete v1 requirement.

## Decision

Wickmail v1 will use SQLite with write-ahead logging, foreign keys enabled, a busy timeout, and versioned migrations. A single process owns writes; the policy lookup and LMTP proxy share that process or coordinate through it. The server will document and test the concurrency assumptions and will move to PostgreSQL only if a concrete requirement such as multi-user concurrency or high availability demands it.

## Consequences

Deployment and backup stay simple and the database is a single file alongside the mail store. Write concurrency is limited, so long-running maintenance tasks must not block the mail path, and migrations must be tested against a copy of production data. A future move to PostgreSQL is possible but would require a migration path and a review of transaction assumptions.
