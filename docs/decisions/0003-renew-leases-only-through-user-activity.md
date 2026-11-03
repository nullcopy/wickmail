# 3. Renew leases only through authenticated user activity

## Status

Accepted

## Context

Users need enough time for receipts and customer support, and may want to reuse an alias for another purchase. If any inbound message renewed a lease, a merchant or spammer could keep the alias active indefinitely. Message headers and thread references do not establish that the user intentionally continued the relationship.

## Decision

We will never renew a lease because of inbound mail. Authenticated outbound mail sent through an owned alias will renew it according to its policy, and explicit app actions will renew, extend, or set its expiry. Sending through an expired alias may reactivate it, but a disabled alias will remain disabled until the user explicitly enables it.

## Consequences

A merchant cannot extend its own access by continuing to send mail. Ongoing support conversations remain convenient because each user reply renews the lease. The server must integrate alias policy with authenticated outbound submission, and users who make another purchase without renewing may need to recover a quarantined confirmation.
