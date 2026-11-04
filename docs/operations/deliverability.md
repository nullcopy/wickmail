# Deliverability: SPF, DKIM, DMARC, rDNS, and TLS

Inbound and outbound mail must authenticate and land in inboxes. This document
covers the DNS and TLS records, the verification script, and the external
test-account checks that an operator runs from a host with outbound mail.

- Records template: [`infra/dns/records.example.zone`](../../infra/dns/records.example.zone).
- Verification script: [`infra/scripts/verify-deliverability.sh`](../../infra/scripts/verify-deliverability.sh).

The DNS half is automated by the script. Inbox placement with external test
accounts is an operator step because it requires third-party mailboxes; it is
documented below with exact commands and checks.

## Records

Replace `example.com`, `mail.example.com`, `203.0.113.10`, and the DKIM public
key with host-specific values. These records are intentionally not in the flake
(see [ADR 0011](../decisions/0011-nix-flake-first-class.md)).

| Purpose       | Name                              | Type | Value                                                                            |
| ------------- | --------------------------------- | ---- | -------------------------------------------------------------------------------- |
| Mail host     | `mail.example.com`                | A    | `203.0.113.10`                                                                   |
| SPF           | `example.com`                     | TXT  | `v=spf1 mx -all`                                                                 |
| DKIM          | `wickmail._domainkey.example.com` | TXT  | `v=DKIM1; k=rsa; p=<public key>`                                                 |
| DMARC         | `_dmarc.example.com`              | TXT  | `v=DMARC1; p=quarantine; adkim=s; aspf=s; pct=100; rua=mailto:dmarc@example.com` |
| TLS reporting | `_smtp._tls.example.com`          | TXT  | `v=TLSRPTv1; rua=mailto:tls@example.com`                                         |
| MTA-STS       | `_mta-sts.example.com`            | TXT  | `v=STSv1; id=<policy id>`                                                        |

Reverse DNS (PTR) is set at the hosting provider: the PTR for the mail host's
IP must resolve to `mail.example.com`, and `mail.example.com` must
forward-resolve to that IP. SPF `mx` and DMARC strict alignment both depend on
this.

DKIM alignment: the outbound path signs with the alias domain's key (see
`apps/server/src/reply/dkim.ts`), and the selector in the DNS record must match
the signer's selector. With `adkim=s`, the `d=` domain must equal the `From`
domain.

## Verification script

```sh
WICKMAIL_DOMAIN=example.com \
WICKMAIL_MAIL_HOST=mail.example.com \
WICKMAIL_MAIL_IP=203.0.113.10 \
WICKMAIL_DKIM_SELECTOR=wickmail \
  infra/scripts/verify-deliverability.sh
```

The script checks, and prints `PASS`/`FAIL` for:

1. SPF TXT exists, terminates with `-all`/`~all`, and authorizes a sender.
2. DKIM TXT exists for the selector and carries a usable public key.
3. DMARC TXT exists, and reports strict alignment and the policy.
4. The mail host's A record resolves and its IP's PTR points back at the host.
5. SMTP STARTTLS presents a certificate (via `openssl s_client`).

It uses `dig` when present, and falls back to DNS-over-HTTPS through
`curl`+`jq`. It exits non-zero when any hard check fails.

## External test-account verification (operator step)

Run these from the mail host after DNS and TLS verify. Record the results in the
MVP checklist.

1. **Outbound inbox placement.** Create test mailboxes with a large provider and
   an independent provider. Send a message through an alias and confirm it
   lands in the inbox, not spam:

   ```sh
   printf 'Subject: wickmail deliverability test\r\n\r\nhello\r\n' |
     swaks --to test@gmail.com --from alias@example.com \
           --server 127.0.0.1 --port 587 --auth-user me@example.com --auth-password "$MAIL_PASSWORD" \
           --tls
   ```

   Check the received headers in the test mailbox: `spf=pass`,
   `dkim=pass (domain=example.com)`, and `dmarc=pass`.

2. **Authentication-Results.** Confirm all three pass and that the DKIM `d=`
   domain is aligned with `From`:

   ```sh
   swaks --to test@example.com --from alias@example.com --server 127.0.0.1 --port 25 \
     --header 'Subject: auth check' --body 'auth check' \
     --dump-as-body --hide-all --output /tmp/wickmail-auth.eml
   grep -i 'Authentication-Results\|DKIM-Signature' /tmp/wickmail-auth.eml
   ```

3. **Inbound reputation.** From an external account, send to a fresh alias and
   confirm the message reaches the inbox while the alias is active and is
   quarantined after expiry.

4. **Reverse DNS.** Confirm the PTR from an external resolver:

   ```sh
   dig +short -x 203.0.113.10
   ```

5. **TLS.** Confirm the certificate chain and hostname:

   ```sh
   openssl s_client -connect mail.example.com:25 -starttls smtp -servername mail.example.com </dev/null |
     openssl x509 -noout -subject -issuer -dates
   ```

If any `Authentication-Results` value is not `pass`, check the DKIM selector,
SPF `mx`, and the PTR before moving the DMARC policy from `p=none` to
`p=quarantine`.
