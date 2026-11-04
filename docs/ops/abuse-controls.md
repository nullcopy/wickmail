# Abuse controls verification

The mail server design requires that quotas, rate limits, and disk-full
behavior hold under realistic conditions, that the server is not an open
relay, and that outbound mail is rate limited. This document describes the
controls and how they are verified.

## Controls

| Control | Default | Where enforced | Option |
|---|---|---|---|
| Maximum message size | 10 MiB | LMTP proxy, temporary failure | `services.wickmail.maxMessageBytes` |
| Per-sender rate limit | 100/hour | LMTP proxy | `services.wickmail.perSenderRate` |
| Global rate limit | 1000/hour | LMTP proxy | `services.wickmail.globalRate` |
| Per-alias quarantine count | 100 | Quarantine retention | `services.wickmail.perAliasQuarantineCount` |
| Per-alias quarantine bytes | 100 MiB | Quarantine retention | `services.wickmail.perAliasQuarantineBytes` |
| Spool entry limit | 10000 | Durable spool | `services.wickmail.maxSpoolEntries` |
| Outbound submission rate | Postfix default | Postfix anvil | `services.wickmail.outboundRateLimit` |
| Management auth rate | 3600/hour | API limiter | not configurable in v1 |
| Open relay | closed | Postfix relay restrictions | not configurable in v1 |

Disk-full behavior returns a temporary failure and raises an alert; the server
never acknowledges a message it did not durably spool, and never silently
drops accepted mail. When a quarantine quota is reached the oldest eligible
messages are deleted first, and messages in `recovering` or `deleting` state
are never deleted.

## Not an open relay

Postfix accepts mail for the alias domain and rejects relay attempts with
`554 5.7.1 Relay access denied`. The module sets `relay_domains = [ domain ]`
and leaves the NixOS defaults for `smtpd_relay_restrictions` in place
(`permit_mynetworks, permit_sasl_authenticated, defer_unauth_destination`).

Verify from an unauthenticated client:

```console
$ printf 'EHLO test\r\nMAIL FROM:<attacker@example.net>\r\nRCPT TO:<victim@elsewhere.example>\r\nQUIT\r\n' \
    | nc mail.example.com 25
...
554 5.7.1 <victim@elsewhere.example>: Relay access denied
```

## Quotas, rate limits, and disk-full

The NixOS VM test [`nix/tests/abuse-controls.nix`](../../nix/tests/abuse-controls.nix)
boots the module with low limits and verifies:

- an oversized message is rejected with a temporary failure (`452`/`552`);
- a per-sender rate limit returns a temporary failure after the configured
  number of messages;
- an unknown recipient is rejected at RCPT with `550`;
- a relay attempt to an external domain is rejected (`554`);
- a spool mounted on a small, full filesystem returns a temporary failure
  rather than accepting and dropping the message.

Run it with:

```console
nix build .#checks.x86_64-linux.abuse-controls
```

The Rust tests cover the same controls at the unit level:

```console
nix develop -c bash -c 'cd apps/server && cargo test abuse'
nix develop -c bash -c 'cd apps/server && cargo test full_spool'
```

## Outbound rate limits

Authenticated submission is limited by Postfix `smtpd_client_message_rate_limit`
through the `submissionOptions` override. Set it with
`services.wickmail.outboundRateLimit`. The alias ownership check
(`check_sender_access socketmap:...:wickmail-submission`) rejects a sender that
is not an owned identity whose lease permits outbound mail, and the reply path
rejects disabled aliases and expired non-renewing aliases before queueing.

Verify with a load tool against port 587 once authenticated; messages beyond
the limit receive `450 4.7.1 ... rate limited`.

## Recorded results

`nix flake check` runs the `mail-path` VM test, which exercises unknown and
disabled rejection, policy-outage temporary failure, and Dovecot-unavailable
spooling, plus the Rust abuse unit tests. The `abuse-controls` VM test records
the message-size, rate-limit, relay, and disk-full results. See the
[release checklist](release-checklist.md) for the current run.
