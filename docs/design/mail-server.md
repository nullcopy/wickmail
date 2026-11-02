# Wickmail mail server design

## Purpose

Provide conventional email hosting with programmable, expiring aliases. An alias controls delivery to the primary mailbox without exposing the mailbox's real address.

The server must:

- Deliver mail from active aliases normally.
- Quarantine mail sent to expired aliases.
- Renew aliases based on authenticated user activity.
- Prevent inbound mail from extending its own delivery window.
- Support sending through an alias without revealing the primary address.
- Expose alias-management operations through an authenticated API.

## Non-goals for v1

- Implementing SMTP or IMAP protocols from scratch.
- Providing webmail or an Android email client.
- Executing arbitrary user-supplied code in the mail-delivery path.
- Automatically inferring purchases or support conversations from message contents.
- Supporting multiple organizations or delegated alias ownership.

## Architecture

Use established mail components with a custom alias-policy service:

```text
                         ┌──────────────────────────┐
Internet ── SMTP ──────► │ Postfix                  │
                         │  - Recipient validation  │
                         │  - Spam/malware checks   │
                         └────────────┬─────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │ Wickmail alias service   │
                         │  - Alias lookup          │
                         │  - Lease evaluation      │
                         │  - Delivery decision     │
                         │  - Lifecycle events      │
                         └────────────┬─────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │ Dovecot LMTP/IMAP        │
                         │  - Inbox                 │
                         │  - Spam                  │
                         │  - Aliases/Expired       │
                         └──────────────────────────┘

User ── authenticated submission ──► Postfix
                                      │
                                      ├─ Verify alias ownership
                                      ├─ Renew alias when applicable
                                      ├─ DKIM-sign message
                                      └─ Deliver externally

Web/Android app ── HTTPS ──► Management API ──► Alias database
                                      │
                                      └─► Quarantine metadata/actions
```

The management API and policy service can initially be one deployable application (`wickmail-server`) with logically separate interfaces.

### Suggested components

- **Postfix:** inbound SMTP and authenticated outbound submission.
- **Dovecot:** IMAP, authentication, and local delivery.
- **Rspamd or equivalent:** spam classification and DKIM signing.
- **Wickmail alias service:** leases, policies, management API, and quarantine actions.
- **Database:** alias definitions, policies, audit events, and quarantine metadata. SQLite is sufficient for a single-user v1; PostgreSQL supports future growth.

## Alias model

Each alias contains:

| Field | Description |
|---|---|
| ID | Stable internal UUID |
| Address | Unique full email address |
| Label | User-facing name, such as "Example Store" |
| Purpose | Optional order, merchant, or notes field |
| Created at | Creation timestamp |
| Expires at | Nullable; null means no expiry |
| Disabled at | Nullable; disabled overrides lease state |
| Lease duration | Default renewal duration |
| Renew on outbound | Whether authenticated sending renews the lease |
| Last inbound at | Informational only |
| Last user activity at | Last outbound, renewal, or recovery action |
| Policy version | Optimistic concurrency control |

The local part may contain a readable prefix and random token, but the address string is not authoritative policy. Changing a lease must not require changing the address.

Alias addresses must never be reassigned to a different purpose or owner. v1 provides disable/archive rather than hard deletion.

## State model

Effective state is calculated at evaluation time:

1. If disabled, the alias is **disabled**.
2. Otherwise, if `expires_at <= now`, it is **expired**.
3. Otherwise, it is **active**.

A scheduler is not required for correct enforcement. It may be added later for expiration notifications.

| State | Inbound behavior | Outbound behavior |
|---|---|---|
| Active | Deliver according to spam policy | Permit and optionally renew |
| Expired | Accept and quarantine | Permit, reactivate, and renew |
| Disabled | Reject at SMTP time | Reject until explicitly enabled |
| Unknown address | Reject at SMTP time | Reject |

All timestamps are stored and evaluated in UTC.

## Lease rules

### Creation

- Default lease: seven days.
- Supported presets: 24 hours, 7 days, 30 days, custom, and no expiry.
- Expiry starts at alias creation.
- The app must create the alias before displaying it as ready to use.

### Inbound activity

Inbound messages never modify `expires_at`, including:

- Order confirmations
- Support responses
- Messages appearing to belong to an existing thread
- Messages with trusted-looking `From`, `Reply-To`, or `References` headers

### Authenticated outbound activity

When the user successfully submits a message using an owned alias:

- If active and `renew_on_outbound` is enabled, set `expires_at = now + lease_duration`.
- If expired, reactivate it using the same calculation.
- If disabled, do not send or implicitly enable it.

Outbound renewal is based on authenticated envelope ownership, not headers in arbitrary inbound SMTP traffic.

### Manual renewal

The API supports:

- **Renew:** set expiry relative to the current time.
- **Extend:** add time to the current expiry if still active.
- **Set expiry:** choose an absolute timestamp.
- **Remove expiry:** make the alias permanent.

These operations are audited.

## Inbound processing

For each incoming message:

1. Validate the recipient against known primary addresses and aliases.
2. Reject unknown or disabled recipients.
3. Perform malware and spam processing.
4. Evaluate the alias's effective state.
5. Deliver active non-spam mail to the inbox.
6. File expired non-spam mail into `Aliases/Expired`.
7. File actual spam into `Spam`, independently of alias state.
8. Record minimal delivery metadata and update `last_inbound_at`.

Messages delivered through an alias should include internal headers such as an alias ID and alias address so mail clients can filter them. These headers must be stripped or appropriately handled on outbound mail.

## Quarantine and recovery

Quarantined messages have metadata containing:

- Internal quarantine ID
- Alias ID
- Sender
- Subject
- Received timestamp
- Quarantine expiry timestamp
- Status: quarantined, recovered, or deleted

Message bodies remain in the mail store; the management database stores only metadata and a storage reference.

Supported actions:

- **Recover:** move one message to the inbox without changing the alias.
- **Recover and renew:** move the message and renew the alias.
- **Delete:** remove the message before normal retention expiry.
- **Disable alias:** prevent further delivery.

Recovery operations must be idempotent so retrying a failed request does not duplicate messages.

Default quarantine retention is 30 days.

## Management API

Use JSON over HTTPS.

### Alias operations

```text
POST   /v1/aliases
GET    /v1/aliases
GET    /v1/aliases/{id}
PATCH  /v1/aliases/{id}
POST   /v1/aliases/{id}/renew
POST   /v1/aliases/{id}/extend
POST   /v1/aliases/{id}/disable
POST   /v1/aliases/{id}/enable
GET    /v1/aliases/{id}/events
```

### Quarantine operations

```text
GET    /v1/quarantine
GET    /v1/quarantine/{id}
POST   /v1/quarantine/{id}/recover
POST   /v1/quarantine/{id}/delete
```

`recover` accepts an option to renew the alias.

### Authentication and authorization

- Browser sessions use `Secure`, `HttpOnly`, and appropriate `SameSite` cookies.
- Cookie-authenticated mutations require CSRF protection.
- Programmatic clients use revocable, scoped API tokens.
- Suggested scopes: `aliases:read`, `aliases:write`, `quarantine:read`, and `quarantine:write`.
- Every operation verifies alias ownership.
- Mutation endpoints support idempotency or safe retry behavior.

## Reliability and security

- Do not operate as an open relay.
- Validate alias ownership before outbound submission.
- Rate-limit outbound mail and management authentication.
- Configure SPF, DKIM, DMARC, reverse DNS, and TLS correctly.
- Keep management services separate from public SMTP authentication.
- Do not log message bodies.
- Restrict delivery metadata retention separately from lifecycle audit history.
- Back up the mail store, alias database, and configuration; test restoration.
- Monitor SMTP queue depth, disk usage, certificate expiry, authentication failures, and policy-service failures.

If alias policy cannot be evaluated, the server must not silently deliver or discard mail. It should temporarily defer delivery or return an SMTP temporary failure so the message remains queued.

## Acceptance criteria

- Mail to an active alias reaches the inbox.
- Inbound messages never extend the lease.
- Mail arriving exactly at or after expiry is quarantined.
- An authenticated outbound message renews an active alias.
- Sending through an expired alias reactivates it.
- A spoofed inbound `MAIL FROM` cannot trigger renewal.
- Disabled aliases neither receive nor send mail.
- Unknown recipients are rejected.
- Recovering a quarantined message does not duplicate it.
- Policy-service outages do not cause message loss.
