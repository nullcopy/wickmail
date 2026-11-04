# Deliverability: SPF, DKIM, DMARC, reverse DNS, and TLS

This guide configures the records and services that make Wickmail mail
authenticate and land in inboxes, and describes the verification procedure.

## DNS records

Publish these records for the alias domain. Replace `example.com` with the
domain, `mail.example.com` with the mail host, and `203.0.113.10` with the
mail host's public address.

| Name | Type | Value |
|---|---|---|
| `example.com` | TXT | `v=spf1 mx -all` |
| `_dmarc.example.com` | TXT | `v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com; adkim=s; aspf=s` |
| `wickmail._domainkey.example.com` | TXT | `v=DKIM1; k=rsa; p=<base64 public key>` |
| `mail.example.com` | A / AAAA | mail host address |
| `example.com` | MX | `10 mail.example.com` |

Set the reverse DNS (PTR) record for the mail host's address to
`mail.example.com`. Most receivers require forward-confirmed reverse DNS:
the PTR name must resolve back to the same address.

If the primary mailbox is at a different provider, use `v=spf1 a:mail.example.com -all`
instead of `mx`, or include the provider's SPF mechanism.

## SPF

SPF authorizes the sending hosts. `v=spf1 mx -all` authorizes the hosts in the
domain's MX records and hard-fails everything else. Do not use `+all` or `~all`
once the records are verified.

## DKIM

Wickmail signs outbound replies with `rsa-sha256`, relaxed/relaxed
canonicalization, for the alias domain (`d=<domain>`) and the configured
selector (`s=<selector>`). Because the signing domain equals the `From`
domain, the signature is DMARC-aligned.

Generate a key and derive the public record:

```console
openssl genrsa -out /etc/wickmail/dkim.pem 2048
openssl rsa -in /etc/wickmail/dkim.pem -pubout -outform DER \
  | base64 -w0
```

Publish the base64 output as the `p=` value in the
`<selector>._domainkey.<domain>` TXT record. Configure the server:

```nix
services.wickmail.dkimKeyFile = "/etc/wickmail/dkim.pem";
services.wickmail.dkimSelector = "wickmail";
```

Restrict the key file to root (`0400`). Rotate by publishing a new selector
first, switching `dkimSelector`, then removing the old record once messages
signed with it have aged out.

## DMARC

DMARC tells receivers what to do when SPF and DKIM both fail, and where to send
reports. `adkim=s` and `aspf=s` require strict alignment, which Wickmail
satisfies for DKIM because the signing domain is the `From` domain. Start at
`p=quarantine` and move to `p=reject` after the reports show clean alignment.

## Reverse DNS

Set the PTR for the mail host address to the mail host name. Verify both
directions:

```console
dig +short -x 203.0.113.10
dig +short mail.example.com A
```

## TLS

Wickmail uses the certificate configured in `services.wickmail.tls` for
Postfix STARTTLS on 25 and 587 and for Dovecot IMAPS on 993. A certificate
from `security.acme` is the recommended source:

```nix
security.acme = {
  acceptTerms = true;
  defaults.email = "postmaster@example.com";
  certs."mail.example.com" = { };
};

services.wickmail.tls = {
  certificateFile = "/var/lib/acme/mail.example.com/fullchain.pem";
  keyFile = "/var/lib/acme/mail.example.com/key.pem";
};
services.wickmail.monitoring.certificateFile = "/var/lib/acme/mail.example.com/fullchain.pem";
```

Submission requires TLS (`smtpd_tls_security_level = encrypt`). Keep the
certificate file world-readable and the key restricted to root; Dovecot opens
both while running as root.

## Verification procedure

The following checks confirm the records and TLS. External inbox placement
must be run from a host with outbound port 25 and is a manual step; this
repository's test environment has no outbound mail path.

1. **Records resolve.**
   ```console
   dig +short TXT example.com
   dig +short TXT wickmail._domainkey.example.com
   dig +short TXT _dmarc.example.com
   dig +short MX example.com
   dig +short -x 203.0.113.10
   ```
2. **TLS is offered and valid.**
   ```console
   openssl s_client -connect mail.example.com:993 -servername mail.example.com </dev/null 2>/dev/null \
     | openssl x509 -noout -subject -dates
   openssl s_client -starttls smtp -connect mail.example.com:587 -servername mail.example.com </dev/null 2>/dev/null \
     | openssl x509 -noout -subject -dates
   ```
3. **SPF and DMARC parse.**
   ```console
   dig +short TXT example.com | grep -q 'v=spf1' && echo SPF ok
   dig +short TXT _dmarc.example.com | grep -q 'v=DMARC1' && echo DMARC ok
   ```
4. **DKIM alignment (offline).** The server's own tests verify that a signed
   reply carries a `DKIM-Signature` whose `d=` equals the `From` domain:
   ```console
   nix develop -c bash -c 'cd apps/server && cargo test dkim'
   ```
5. **External test accounts (manual).** Send a reply through the app to each
   of the following and inspect the `Authentication-Results` header:
   - A Gmail account: `Show original` shows `spf=pass`, `dkim=pass`, and
     `dmarc=pass` with an aligned domain.
   - Microsoft Outlook: `View message source` shows the same.
   - `check-auth@verifier.port25.com` returns a summary by email covering SPF,
     DKIM, DMARC, and SpamAssassin.
   - `dkimvalidator.com` accepts a message and reports the DKIM result.

   Record the date, the receiving provider, and the three authentication
   results for each account.

## Recorded results

This repository's CI runs `nix flake check`, which builds the server and runs
the DKIM unit tests; those confirm signing and DMARC alignment offline. DNS
propagation, reverse DNS, and external inbox placement require a live domain
and outbound port 25, which are not available in this environment. Perform
steps 1-5 above on the deployed host and record the results here.
