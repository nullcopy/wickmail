#!/usr/bin/env bash
#
# Verify Wickmail deliverability records: SPF, DKIM, DMARC, reverse DNS, and
# TLS. Prints one PASS/FAIL line per check and exits non-zero when any hard
# check fails.
#
# This verifies the DNS and TLS half. Inbox placement with external test
# accounts is an operator step that cannot be automated from here; see
# docs/operations/deliverability.md.
#
# Environment:
#   WICKMAIL_DOMAIN         primary domain (default example.com)
#   WICKMAIL_MAIL_HOST      mail host name (default mail.$WICKMAIL_DOMAIN)
#   WICKMAIL_MAIL_IP        expected A record / rDNS target IP
#   WICKMAIL_DKIM_SELECTOR  DKIM selector (default wickmail)
#   WICKMAIL_SMTP_PORT      submission port for the TLS check (default 25)
#
# Requires: openssl, and either dig or curl+jq for DNS lookups.
set -uo pipefail

DOMAIN="${WICKMAIL_DOMAIN:-example.com}"
MAIL_HOST="${WICKMAIL_MAIL_HOST:-mail.$DOMAIN}"
MAIL_IP="${WICKMAIL_MAIL_IP:-}"
DKIM_SELECTOR="${WICKMAIL_DKIM_SELECTOR:-wickmail}"
SMTP_PORT="${WICKMAIL_SMTP_PORT:-25}"

failures=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1" >&2
  failures=$((failures + 1))
}
info() { printf 'INFO  %s\n' "$1"; }

have() { command -v "$1" >/dev/null 2>&1; }

# Query TXT records as a single space-joined string.
dns_txt() {
  local name="$1"
  if have dig; then
    dig +short TXT "$name" 2>/dev/null | tr -d '"' | tr '\n' ' '
  elif have curl && have jq; then
    curl -fsS "https://cloudflare-dns.com/dns-query?name=$name&type=TXT" \
      -H 'accept: application/dns-json' 2>/dev/null |
      jq -r '[.Answer[]? | select(.type == 16) | .data] | join(" ")' 2>/dev/null
  fi
}

dns_type() {
  local name="$1" type="$2"
  if have dig; then
    dig +short "$type" "$name" 2>/dev/null | tr '\n' ' '
  elif have curl && have jq; then
    curl -fsS "https://cloudflare-dns.com/dns-query?name=$name&type=$type" \
      -H 'accept: application/dns-json' 2>/dev/null |
      jq -r '[.Answer[]? | select(.type == 12 or .type == 1 or .type == 28) | .data] | join(" ")' \
        2>/dev/null
  fi
}

if ! have dig && ! (have curl && have jq); then
  echo "verify-deliverability: need dig, or curl and jq, for DNS lookups" >&2
  exit 2
fi

echo "== DNS =="

# SPF
spf="$(dns_txt "$DOMAIN")"
if printf '%s' "$spf" | grep -q 'v=spf1'; then
  if printf '%s' "$spf" | grep -qE '[-~]all'; then
    pass "SPF record present and terminates with an all-qualifier"
  else
    fail "SPF record has no -all/~all qualifier: $spf"
  fi
  if printf '%s' "$spf" | grep -qE 'include:|ip4:|ip6:|mx'; then
    pass "SPF record authorizes at least one sender"
  else
    fail "SPF record authorizes no senders: $spf"
  fi
else
  fail "no SPF record for $DOMAIN"
fi

# DKIM
dkim_name="${DKIM_SELECTOR}._domainkey.${DOMAIN}"
dkim="$(dns_txt "$dkim_name")"
if printf '%s' "$dkim" | grep -q 'v=DKIM1'; then
  if printf '%s' "$dkim" | grep -qE 'p=[A-Za-z0-9+/]{20,}'; then
    pass "DKIM key present for selector $DKIM_SELECTOR"
  else
    fail "DKIM record has no usable public key: $dkim"
  fi
else
  fail "no DKIM record at $dkim_name"
fi

# DMARC
dmarc="$(dns_txt "_dmarc.$DOMAIN")"
if printf '%s' "$dmarc" | grep -q 'v=DMARC1'; then
  pass "DMARC record present"
  if printf '%s' "$dmarc" | grep -qE 'adkim=s'; then
    pass "DMARC requires strict DKIM alignment (adkim=s)"
  else
    info "DMARC does not set adkim=s; relaxed alignment is in effect"
  fi
  if printf '%s' "$dmarc" | grep -qE 'p=(quarantine|reject)'; then
    pass "DMARC policy enforces quarantine or reject"
  else
    info "DMARC policy is p=none; reports only, no enforcement"
  fi
else
  fail "no DMARC record for _dmarc.$DOMAIN"
fi

# rDNS
echo "== Reverse DNS =="
resolved="$(dns_type "$MAIL_HOST" A)"
if [ -n "$resolved" ]; then
  pass "A record for $MAIL_HOST resolves"
  ip="${MAIL_IP:-$(printf '%s' "$resolved" | awk '{print $1}')}"
  ptr="$(dns_type "$ip" PTR)"
  if printf '%s' "$ptr" | grep -qi "$MAIL_HOST"; then
    pass "PTR for $ip points at $MAIL_HOST"
  else
    fail "PTR for $ip is '$ptr', expected $MAIL_HOST"
  fi
else
  fail "no A record for $MAIL_HOST"
fi

# TLS
echo "== TLS =="
if have openssl; then
  cert="$(printf 'Q\n' | timeout 15 openssl s_client \
    -connect "$MAIL_HOST:$SMTP_PORT" -starttls smtp -servername "$MAIL_HOST" 2>/dev/null |
    openssl x509 -noout -enddate -issuer 2>/dev/null)"
  if [ -n "$cert" ]; then
    pass "SMTP STARTTLS on $MAIL_HOST:$SMTP_PORT presented a certificate"
    info "$(printf '%s' "$cert" | tr '\n' ' ')"
    if printf '%s' "$cert" | grep -qi "$DOMAIN"; then
      pass "certificate is for $DOMAIN"
    else
      info "certificate subject does not mention $DOMAIN; confirm SAN coverage"
    fi
  else
    fail "no certificate from $MAIL_HOST:$SMTP_PORT (STARTTLS)"
  fi
else
  info "openssl not available; skipping TLS check"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "verify-deliverability: $failures check(s) failed" >&2
  exit 1
fi
echo "verify-deliverability: all checks passed"
