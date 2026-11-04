# wickmail infra

Deployment, mail server configuration, and operational tooling for Wickmail.

Scope:

- Nix flake deployment outputs: NixOS modules, packages, and container images
- Postfix, Dovecot, and spam-filter configuration
- DNS records: SPF, DKIM, DMARC, reverse DNS
- TLS certificate management
- Backup and restore scripts
- Monitoring and alerting

See [mail server design](../docs/design/mail-server.md) and [ADR 0011](../docs/decisions/0011-nix-flake-first-class.md).

Status: the operational tooling is implemented.

- `nixosModules.default` (and `wickmail-mail`) configures Postfix (RCPT policy
  lookup and LMTP delivery), Rspamd (spam and malware before the proxy), and
  Dovecot (LMTP, IMAP, mail auth, and the global Sieve routing script). The
  flake's `nixos-modules` check evaluates the module against
  [`nixos/test-configuration.nix`](nixos/test-configuration.nix) without
  building the mail stack.
- `nixosModules.wickmail-backup` installs a systemd service and timer that run
  [`scripts/backup.sh`](scripts/backup.sh).
- `scripts/` holds the backup, restore, reconciliation drill, deliverability
  verification, and Postfix queue collection scripts.
- `dns/` holds the SPF, DKIM, DMARC, reverse DNS, and TLS record templates.
- `monitoring/` holds the Prometheus scrape example and alert rules.

Guides live under [docs/operations](../docs/operations/README.md). The server
package itself is not built by the flake yet; see the
[release notes](../docs/release/v0.1.0-notes.md).
