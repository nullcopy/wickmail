# Backups and restore drill

Self-hosting requires tested recovery. Wickmail backs up the mail store, the
SQLite alias database, and the configuration, and ships a restore path that
reconciles the mail store against the database afterwards.

## What is backed up

| Component | Path | Method |
|---|---|---|
| Alias database | `/var/lib/wickmail/wickmail.sqlite` | `sqlite3 .backup` snapshot (safe while running) |
| Durable spool | `/var/lib/wickmail/spool` | file copy |
| Outbound queue | `/var/lib/wickmail/outbound` | file copy |
| Mail store | `/var/vmail` (Maildir and quarantine) | file copy |
| Configuration | `backup.configDirectory` (for example `/etc/wickmail`) | file copy |

The NixOS configuration itself is not captured; keep it in version control.
The backup records the server version, schema version, and the database
checksum in a `MANIFEST`.

## Scheduling

```nix
services.wickmail.backup = {
  enable = true;
  outputDirectory = "/var/backup/wickmail";
  schedule = "*-*-* 03:30:00";
  retention = 14;
  configDirectory = "/etc/wickmail";
};
```

Enabling backups installs `wickmail-backup.timer`. Each run writes
`wickmail-backup-<timestamp>.tar.gz` and a matching `.sha256`, then prunes
archives older than `retention`. Run one by hand with:

```console
wickmail-backup --state-dir /var/lib/wickmail --mail-root /var/vmail \
  --output /var/backup/wickmail --config-dir /etc/wickmail
```

Store backups off the host. The archive contains mail bodies and the database,
so protect it at rest.

## Restore

Restore with the mail services stopped so the restored files are not rewritten
mid-copy:

```console
sudo systemctl stop wickmail dovecot postfix
sudo wickmail-restore --archive /var/backup/wickmail/wickmail-backup-<stamp>.tar.gz \
  --state-dir /var/lib/wickmail --mail-root /var/vmail \
  --config-dir /etc/wickmail --reconcile
sudo systemctl start wickmail dovecot postfix
```

`wickmail-restore` verifies the archive checksum, refuses to overwrite a
non-empty target unless `--force` is given, migrates the restored database,
and — with `--reconcile` — runs quarantine reconciliation. Reconciliation is
idempotent and repairs a mail store that disagrees with the database, so a
restore converges even if it lands while the server is running.

## Drill

The drill verifies that a backup restores and reconciles cleanly. The NixOS VM
test [`nix/tests/backup-restore.nix`](../../nix/tests/backup-restore.nix)
runs it end to end:

1. Boot the module and create an active alias and an expired alias.
2. Deliver a message to the active alias (Inbox) and one to the expired alias
   (quarantine).
3. Run `wickmail-backup` into a scratch directory.
4. Simulate loss: stop the services, delete the database and mail store, and
   delete the quarantine body to create a disagreement.
5. Run `wickmail-restore --reconcile`.
6. Verify the alias database, the Inbox message, and the quarantine metadata
   survived, and that reconciliation reports a repair rather than an error.

Run it with:

```console
nix build .#checks.x86_64-linux.backup-restore
```

## Recorded result

`nix build .#checks.x86_64-linux.backup-restore` passed: the drill delivered
mail to an active and an expired alias, backed up the database and mail store,
removed them, restored the archive, and verified that reconciliation repaired
the missing quarantine body (`deleted=1`). After the restore the account
authenticated over IMAP, the restored inbox message was present, and the
active alias still accepted mail.
