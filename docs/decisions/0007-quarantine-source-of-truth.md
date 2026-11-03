# 7. Treat the mail store as the quarantine source of truth

## Status

Accepted

## Context

Quarantined message bodies live in the mail store while lifecycle status lives in the management database. A crash during recovery, deletion, or retention can leave the two stores disagreeing, producing duplicates, missing mail, or stale status. IMAP UIDs and `UIDVALIDITY` values change across moves, mailbox rebuilds, and restores, so they cannot serve as stable message identity.

## Decision

The mail store is authoritative for whether a message is in quarantine. The management database holds reconciled metadata and a cached locator for fast access, but it can always be rebuilt from the mail store.

Every message accepted for an alias receives a stable `X-Wickmail-Message-ID` header containing a UUIDv7. That identifier survives moves and mailbox rebuilds and is the identity used for reconciliation. The database caches mailbox, `UIDVALIDITY`, and UID only as a locator and never treats them as identity.

`Aliases/Expired` is isolated from the user's IMAP namespace, so external clients cannot move or delete quarantine messages. Recovery uses a crash-safe state machine: record intent, copy the message to the inbox, verify the inbox copy by message ID, delete the quarantine copy, and mark the metadata recovered. If a crash leaves a copy in both folders, reconciliation keeps the inbox copy and removes the quarantine copy. Deletion and retention mark intent, delete the body, then mark the metadata deleted, and reconciliation repairs either half. Retention skips messages in recovery or deletion states.

Spam retention is configured separately from lease quarantine retention.

## Consequences

Recovery and retention can be retried safely, and either store can be restored without losing quarantine membership. The server needs a reconciliation process that runs at startup, periodically, and before destructive operations. The mail-store adapter becomes a required internal component, and direct user access to `Aliases/Expired` is intentionally unavailable.
