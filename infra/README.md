# wickmail infra

Deployment, mail server configuration, and operational tooling for Wickmail.

Scope:

- Nix flake deployment outputs: NixOS modules, packages, and container images, including the Rust `wickmail-server` binary
- Postfix, Dovecot, and spam-filter configuration
- DNS records: SPF, DKIM, DMARC, reverse DNS
- TLS certificate management
- Backup and restore scripts
- Monitoring and alerting

See [mail server design](../docs/design/mail-server.md) and [ADR 0011](../docs/decisions/0011-nix-flake-first-class.md).

## Inbound mail path module

`nixosModules.default` wires the inbound mail path from ADR 0006. It configures:

- **Postfix** to look up recipients at RCPT through a Wickmail socketmap and to
  deliver accepted mail to the Wickmail LMTP proxy. Unknown and disabled
  recipients are rejected with a permanent failure; a policy outage returns a
  temporary failure.
- **Rspamd** as a Postfix milter, so spam and malware classification runs
  before the proxy.
- **Dovecot** with LMTP, IMAP, and mail authentication, plus a global Sieve
  script that routes on the trusted `X-Wickmail-Route` header to `Inbox`,
  `Spam`, or `Aliases/Expired`.
- **wickmail-server** as a systemd service that owns the alias database, the
  RCPT policy socketmap, the LMTP proxy, and the durable spool.

### Usage

```nix
{
  imports = [ wickmail.nixosModules.default ];

  services.wickmail = {
    enable = true;
    domain = "example.com";
    primaryAddress = "user@example.com";
    # Required; supply from a secret manager. There is no default.
    mailPassword = "<generated mail password>";
  };
}
```

### Layout

| Path | Purpose |
|---|---|
| `/run/wickmail/policy.sock` | Postfix socketmap for RCPT policy lookup |
| `/run/wickmail/lmtp.sock` | LMTP socket Postfix delivers to |
| `/run/dovecot2/lmtp` | Dovecot LMTP socket the proxy forwards to |
| `/var/lib/wickmail/wickmail.sqlite` | Alias database |
| `/var/lib/wickmail/spool` | Durable spool |
| `/var/vmail/Maildir` | Account mail store |
| `/var/vmail/quarantine` | Quarantine Maildir, outside the user IMAP namespace |

### Operational commands

```console
# Create an alias with a deterministic address.
wickmail-server create-alias --db /var/lib/wickmail/wickmail.sqlite \
  --domain example.com --local-part green.farm --lease 86400

# Inspect the spool.
wickmail-server spool-stats --dir /var/lib/wickmail/spool

# Read the quarantine mailbox through the internal adapter.
wickmail-server mail-store quarantine --maildir /var/vmail/Maildir \
  --quarantine-dir /var/vmail/quarantine/.Expired
```

### Operational options

| Option | Purpose |
|---|---|
| `services.wickmail.dkimKeyFile` / `dkimSelector` | DKIM-sign outbound replies, aligned for DMARC |
| `services.wickmail.tls.certificateFile` / `tls.keyFile` | TLS for Postfix and Dovecot |
| `services.wickmail.maxMessageBytes`, `perSenderRate`, `globalRate` | Inbound abuse limits |
| `services.wickmail.perAliasQuarantineCount` / `perAliasQuarantineBytes` | Quarantine quotas |
| `services.wickmail.outboundRateLimit` | Postfix submission rate limit |
| `services.wickmail.backup.*` | Scheduled backups (`wickmail-backup.timer`) |
| `services.wickmail.monitoring.*` | Health checks and alerts (`wickmail-monitor.timer`) |

### Operational scripts

`wickmail-backup` archives the alias database (via `sqlite3 .backup`), the
spool, the outbound queue, the mail store, and a configuration directory.
`wickmail-restore` verifies and extracts an archive and can run quarantine
reconciliation. `wickmail-monitor` checks spool depth and age, disk usage,
certificate expiry, authentication failures, policy-service failures, and
reconciliation results, then alerts through journald and an optional webhook.
See [docs/ops](../docs/ops/README.md).

### Integration tests

`nix flake check` runs:

- `nix/tests/mail-path.nix` starts Postfix, Rspamd, Dovecot, and
  wickmail-server together and verifies active delivery to `Inbox`, expiry
  routing to `Aliases/Expired`, unknown and disabled rejection at RCPT, a
  temporary failure while the policy service is down, and stripping of
  spoofed `X-Wickmail-*` headers.
- `nix/tests/backup-restore.nix` backs up a running system, simulates loss,
  restores it, and verifies reconciliation repairs the mail store.
- `nix/tests/abuse-controls.nix` verifies the message-size and rate limits,
  open-relay rejection, outbound rate limiting, and disk-full behavior.
