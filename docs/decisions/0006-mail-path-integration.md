# 6. Integrate mail through a Postfix policy lookup and a Wickmail LMTP proxy

## Status

Accepted

## Context

Recipient validation, lease evaluation, spam handling, and folder routing happen at different points in the SMTP transaction and have different failure semantics. The previous design showed Postfix sending to a Wickmail alias service and then to Dovecot without naming the integration mechanism or saying when each decision is made. Once Postfix accepts a message, the server must not permanently reject it for policy reasons. Client-supplied alias headers must never be trusted, and `Aliases/Expired` must not be writable by ordinary IMAP clients.

## Decision

We will use two explicit integration points:

1. **Recipient validation at RCPT.** Postfix calls a Wickmail policy lookup over a Unix socket or socketmap. The lookup rejects unknown and disabled recipients with a permanent SMTP failure, accepts active and expired recipients, and returns a temporary failure when the alias database is unavailable. It never reports an unknown recipient because of an internal error.
2. **Final routing at delivery.** Postfix delivers to a Wickmail LMTP proxy instead of directly to Dovecot. The proxy strips every client-supplied `X-Wickmail-*` header, evaluates the lease at delivery, adds trusted headers including a stable message ID, alias IDs, and a route, durably spools the message, and only then acknowledges it. The proxy forwards the spooled message to Dovecot LMTP.

Dovecot uses a global Sieve script that routes on the trusted `X-Wickmail-Route` header to `Inbox`, `Spam`, or `Aliases/Expired`. Spam and malware classification runs before the proxy and sets headers that Sieve honors, so actual spam goes to `Spam` regardless of alias state. `Aliases/Expired` is isolated from the user's IMAP namespace; the management app accesses it through an internal mail-store adapter.

Post-acceptance failures return temporary LMTP failures or remain in the proxy spool. The server never issues a permanent rejection or bounce for alias policy after SMTP acceptance.

## Consequences

Recipient validation and delivery routing have separate, testable contracts, and the LMTP proxy is the single place where delivery-time policy and trusted headers are applied. The proxy and its spool become critical infrastructure: if the spool is unavailable, the proxy returns a temporary failure before acceptance, and if it is full, alerts fire. Dovecot Sieve must trust only headers added after the strip step, and the internal adapter must be the only path into the quarantine folder.
