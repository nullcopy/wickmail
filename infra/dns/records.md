# DNS records

Reference records for a Wickmail deployment. Replace `example.com`,
`mail.example.com`, `203.0.113.10`, and the DKIM public key. See
[docs/ops/deliverability.md](../../docs/ops/deliverability.md) for the
configuration and verification procedure.

```zone
; Address and mail routing
mail.example.com.            3600 IN A     203.0.113.10
mail.example.com.            3600 IN AAAA  2001:db8::10
example.com.                 3600 IN MX    10 mail.example.com.

; Reverse DNS for the mail host address (set at the address provider)
10.113.0.203.in-addr.arpa.   3600 IN PTR   mail.example.com.

; SPF: authorize the mail host, hard-fail everything else
example.com.                 3600 IN TXT   "v=spf1 mx -all"

; DKIM: public key for selector "wickmail"
wickmail._domainkey.example.com. 3600 IN TXT "v=DKIM1; k=rsa; p=<base64 public key>"

; DMARC: strict alignment, quarantine on failure, aggregate reports
_dmarc.example.com.          3600 IN TXT   "v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com; adkim=s; aspf=s"
```
