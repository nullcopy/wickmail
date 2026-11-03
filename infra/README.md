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

Status: not implemented.
