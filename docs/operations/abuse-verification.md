# Abuse-control verification

This document records how quotas, rate limits, disk-full behavior, open-relay
prevention, and outbound rate limits are confirmed. Most are covered by
automated tests; the production-like steps confirm the wiring under the real
mail stack.

- Limits: [`apps/server/src/abuse/limits.ts`](../../apps/server/src/abuse/limits.ts).
- Tests: [`apps/server/test/abuse-limits.test.ts`](../../apps/server/test/abuse-limits.test.ts),
  [`apps/server/test/metrics.test.ts`](../../apps/server/test/metrics.test.ts).
- Module: [`infra/nixos/wickmail-mail.nix`](../../infra/nixos/wickmail-mail.nix).

## Automated coverage

| Control                     | Verified by                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Management auth rate limit  | `abuse-limits.test.ts` ("rate limits management authentication") — the second login returns `429` with `Retry-After`. |
| Inbound rate limits         | `abuse-limits.test.ts` ("rate limits inbound mail per sender and globally") — per-sender limit yields a tempfail.     |
| Outbound rate limit         | `abuse-limits.test.ts` ("rate limits outbound submissions and counts the deferral").                                  |
| Quarantine quotas           | `abuse-limits.test.ts` ("deletes the oldest quarantined messages first when a quota is exceeded").                    |
| Disk full                   | `abuse-limits.test.ts` ("returns a temporary failure and alerts when the spool is full"); `spool.test.ts`.            |
| Open relay (RCPT)           | `abuse-limits.test.ts` ("rejects a recipient outside the local domains at RCPT").                                     |
| Open relay (delivery)       | `abuse-limits.test.ts` ("never accepts an external recipient at delivery").                                           |
| Open relay (Postfix config) | `nixos-module.test.ts` ("does not operate as an open relay").                                                         |
| Abuse controls as metrics   | `metrics.test.ts` ("counts accepted messages and deferred stages", alert sink).                                       |

Run them with `nix develop -c npm test`.

## Production-like verification

Run these against a staging deployment with the real Postfix, Rspamd, and
Dovecot stack. Each step names the observable result.

### Quotas

1. Create an alias with no expiry and send more messages than the per-alias
   quarantine quota. With defaults, the quota is 1000 messages per alias and
   5000 overall.
2. Confirm the oldest eligible messages are deleted first and that messages in
   `recovering` or `deleting` state are never deleted:

   ```sh
   curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/metrics |
     grep wickmail_quarantine_entries
   ```

   The `quarantined` count stays at or below the configured maximum.

### Inbound rate limits

```sh
for i in $(seq 1 50); do
  swaks --to me@example.com --from flood@example.net --server 127.0.0.1 --port 25 \
    --header "Subject: flood $i" --body x --timeout 5 || true
done
```

Past `inboundPerSenderPerMinute` (default 30) the server defers with a `451`.
Confirm `wickmail_messages_tempfailed_total{stage="rate_limit"}` increases.

### Disk full

1. Fill the spool filesystem (for example with a loopback filesystem mounted at
   `WICKMAIL_SPOOL_DIR`) until free space is below the floor.
2. Send a message. Postfix receives a temporary failure and retries; nothing is
   accepted-then-dropped.
3. Confirm `wickmail_disk_ok{path=...}` is `0` and
   `wickmail_alerts_total{kind="disk_full"}` increases.

### Open relay

```sh
# External recipient must be rejected at RCPT, not relayed.
swaks --to victim@external.example --from attacker@external.example \
  --server 127.0.0.1 --port 25 --quit-after RCPT
# Expect: 550 (unknown recipient) or 451 when policy is unavailable, never 250.
```

Confirm the Postfix configuration keeps `reject_unauth_destination` and does not
list external domains in `relay_domains`:

```sh
postconf -n | grep -E 'smtpd_recipient_restrictions|relay_domains'
```

### Outbound rate limits

Submit more replies than `outboundPerMinute` (default 60) in a minute through
the management API. Submissions past the limit return a temporary failure and
`wickmail_outbound_tempfailed_total{reason="rate_limit"}` increases. The alias
lease does not renew for a deferred submission.

```sh
curl -fsS http://127.0.0.1:8080/metrics | grep wickmail_outbound_tempfailed_total
```
