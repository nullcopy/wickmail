# Backup and restore

Wickmail backs up the SQLite database, the mail store, the isolated quarantine
store, the durable spool, and the host configuration. Restoration is a
documented, exercised procedure, and reconciliation runs after every restore to
repair any metadata the restore left inconsistent with the mail store.

- Scripts: [`infra/scripts/backup.sh`](../../infra/scripts/backup.sh),
  [`infra/scripts/restore.sh`](../../infra/scripts/restore.sh),
  [`infra/scripts/drill.sh`](../../infra/scripts/drill.sh).
- NixOS module: [`services.wickmail.backup`](../../infra/nixos/wickmail-backup.nix)
  installs a systemd service and timer around `backup.sh`.
- Automated drill: `apps/server/test/backup-restore-drill.test.ts`, run with
  `infra/scripts/drill.sh` or
  `nix develop -c npm test --workspace wickmail-server -- backup-restore-drill`.

## What is backed up

| Component        | Source                    | Notes                                            |
| ---------------- | ------------------------- | ------------------------------------------------ |
| SQLite database  | `WICKMAIL_DB`             | Snapshotted with SQLite `.backup`, WAL-safe.     |
| Mail store       | `WICKMAIL_MAIL_DIR`       | Dovecot mail root.                               |
| Quarantine store | `WICKMAIL_QUARANTINE_DIR` | Isolated `Aliases/Expired` namespace.            |
| Durable spool    | `WICKMAIL_SPOOL_DIR`      | Accepted mail not yet delivered to Dovecot.      |
| Configuration    | `WICKMAIL_CONFIG_DIR`     | Host-specific values; never secrets in the repo. |

The archive is a gzip tarball with a `manifest.txt` naming the source paths and
a sibling `<archive>.sha256` digest.

## Manual backup

```sh
WICKMAIL_DB=/var/lib/wickmail/wickmail.db \
WICKMAIL_MAIL_DIR=/var/vmail \
WICKMAIL_QUARANTINE_DIR=/var/vmail-quarantine \
WICKMAIL_SPOOL_DIR=/var/lib/wickmail/spool \
WICKMAIL_CONFIG_DIR=/etc/wickmail \
BACKUP_DIR=/var/backups/wickmail \
  infra/scripts/backup.sh
```

The archive path is printed on stdout. The database is snapshotted online, so
the server does not need to be stopped for a backup.

## Scheduled backups

Enable the NixOS module, which writes to `/var/backups/wickmail` nightly at
02:30 and prunes archives older than 14 days:

```nix
services.wickmail.backup = {
  enable = true;
  schedule = "*-*-* 02:30:00";
  retentionDays = 14;
};
```

## Restore procedure

1. Stop the mail path and the management API so nothing writes during the
   restore:

   ```sh
   systemctl stop wickmail-server postfix dovecot2
   ```

2. Restore the archive. Existing non-empty destinations and an existing database
   are only overwritten with `--force`:

   ```sh
   WICKMAIL_DB=/var/lib/wickmail/wickmail.db \
   WICKMAIL_MAIL_DIR=/var/vmail \
   WICKMAIL_QUARANTINE_DIR=/var/vmail-quarantine \
   WICKMAIL_SPOOL_DIR=/var/lib/wickmail/spool \
   WICKMAIL_CONFIG_DIR=/etc/wickmail \
     infra/scripts/restore.sh --force /var/backups/wickmail/wickmail-backup-<timestamp>.tar.gz
   ```

3. Reconcile the quarantine metadata with the mail store, which is
   authoritative for membership. Reconciliation is idempotent and repairs both
   directions:

   ```sh
   WICKMAIL_DB=/var/lib/wickmail/wickmail.db \
   WICKMAIL_MAIL_DIR=/var/vmail \
     wickmail-server admin reconcile
   ```

   The command prints a JSON report with `scanned`, `recovered`,
   `requarantined`, `deleted`, `rebuilt`, and `relinked` counts. `rebuilt > 0`
   or `requarantined > 0` means the restore was inconsistent and reconciliation
   repaired it.

4. Start the services and confirm health:

   ```sh
   systemctl start wickmail-server postfix dovecot2
   curl -fsS http://127.0.0.1:8080/metrics | grep wickmail_reconciliation
   ```

## Automated drill

The drill drives the real `backup.sh` and `restore.sh` against a temporary
SQLite database and mail store, seeds a quarantined message in a state that
simulates a crash mid-recovery, backs up, deletes the live state, restores, and
runs reconciliation. It asserts that reconciliation repaired the state and that
the database passes `PRAGMA integrity_check`.

```sh
infra/scripts/drill.sh
```

Recorded result (branch `m9-ops-release`, `nix develop -c npm test`):

```text
Test Files  1 passed (1)
     Tests  3 passed (3)
```

The three tests cover the backup → restore → reconciliation path, the refusal
to overwrite existing state without `--force`, and rejection of an archive whose
checksum does not match.

`nix flake check` additionally parse-checks every script under `infra/scripts/`
(`checks.backup-scripts`).
