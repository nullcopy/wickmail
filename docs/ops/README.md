# Operations

Operational guides for running Wickmail. See [ADR 0011](../decisions/0011-nix-flake-first-class.md)
for why deployment goes through the flake and the NixOS modules.

| Guide | Covers |
|---|---|
| [deployment.md](deployment.md) | Install and upgrade with the NixOS modules, bootstrap, and recovery |
| [backup-restore.md](backup-restore.md) | Backups, restore, and the reconciliation drill |
| [monitoring.md](monitoring.md) | Health signals, alerting, and Prometheus integration |
| [deliverability.md](deliverability.md) | SPF, DKIM, DMARC, reverse DNS, TLS, and verification |
| [abuse-controls.md](abuse-controls.md) | Quotas, rate limits, disk-full behavior, and open-relay checks |
| [release-checklist.md](release-checklist.md) | MVP acceptance mapping, release notes, and known limitations |

Operational scripts live under [`infra/`](../../infra/README.md):
`wickmail-backup`, `wickmail-restore`, and `wickmail-monitor`.
