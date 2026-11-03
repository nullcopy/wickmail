# 4. Quarantine mail for expired aliases

## Status

Accepted

## Context

Rejecting or discarding all mail to an expired alias would enforce the lease strictly but could permanently lose a receipt or support response when a user forgets to renew. Filing that mail as spam would mix lease enforcement with spam classification and could train the spam filter incorrectly.

## Decision

We will accept non-spam mail addressed to expired aliases and store it in quarantine for 30 days by default. The app will allow users to recover a message, recover and renew the alias, or delete the message. Actual spam will remain subject to spam handling, and disabled or unknown aliases will be rejected at SMTP time.

## Consequences

Expiration becomes reversible and important mail remains recoverable. Quarantine requires storage, retention cleanup, metadata, and recovery operations that move mail without duplicating it. The app needs a distinct quarantine interface, and the server must keep lease-based quarantine separate from spam classification.
