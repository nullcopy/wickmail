# 8. Reply as an alias from the first-party app

## Status

Accepted

## Context

Users read mail in standard IMAP clients, which cannot reliably choose an alias as the sending identity. A reply sent from an arbitrary client uses whatever identity that client is configured with, typically the primary address, which defeats alias separation. The management app already knows which alias received a message, so it can provide a controlled reply path.

## Decision

Wickmail v1 includes a first-party reply action in the management app. It is a focused reply composer, not a general webmail. The app fetches sanitized reply context for a message, including the original sender, subject, text, and trusted alias provenance, and sends the reply through the management API.

The server records trusted provenance at inbound acceptance from the SMTP envelope recipients, cross-checked against visible `To` and `Cc`. Envelope recipients are authoritative because they include blind copies; visible headers are used for display only. Provenance is stored as the set of alias IDs and whether the primary address received the message.

Reply identity selection follows these rules:

| Provenance              | Reply identity                                                  |
| ----------------------- | --------------------------------------------------------------- |
| Exactly one alias       | That alias, with the primary identity offered as an alternative |
| No alias (primary only) | The primary identity                                            |
| Multiple aliases        | Prompt the user; never select silently                          |

If both the primary address and exactly one alias received the message, the alias is the default and the primary is offered. If multiple aliases received it, the user must choose even if the primary also received it.

The server enforces outbound identity: the envelope sender and the single `From` mailbox must both be the selected owned alias; a present `Sender` must equal the alias; `Reply-To` is omitted by default and may only be set to the sending alias in v1. The server strips inbound-only and primary-revealing headers, and DKIM-signs with the alias domain's key.

An alias renews after the authenticated message is accepted and queued, not during pre-queue checks. A later bounce does not revert the renewal.

## Consequences

Alias replies preserve the alias identity and renew the lease without depending on client configuration. The app gains a focused compose surface, and the server must maintain provenance and reply-context APIs. The server cannot prevent a user from replying from an arbitrary client with the primary identity; that path simply remains outside the controlled alias reply flow. Attachments and rich composition are deferred until the reply path is proven.
