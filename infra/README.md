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

Status: the NixOS mail module is implemented. `nixosModules.default` configures Postfix (RCPT policy lookup and LMTP delivery), Rspamd (spam and malware before the proxy), and Dovecot (LMTP, IMAP, mail auth, and the global Sieve routing script). The flake's `nixos-modules` check evaluates the module against [`nixos/test-configuration.nix`](nixos/test-configuration.nix) without building the mail stack. Packages, DNS automation, TLS, backup, and monitoring are not implemented yet.
