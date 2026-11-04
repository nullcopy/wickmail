#!/usr/bin/env bash
#
# Back up the Wickmail mail store, SQLite database, and configuration into a
# single timestamped archive.
#
# The database is snapshotted with SQLite's online `.backup` command, which is
# safe while the server is running and handles write-ahead logging. The mail,
# quarantine, spool, and configuration trees are copied into the archive as-is.
#
# Environment (all optional; defaults match the NixOS module):
#   WICKMAIL_DB               SQLite database file
#   WICKMAIL_MAIL_DIR         Dovecot mail root
#   WICKMAIL_QUARANTINE_DIR   isolated quarantine mail root
#   WICKMAIL_SPOOL_DIR        durable spool directory
#   WICKMAIL_CONFIG_DIR       host configuration directory
#   BACKUP_DIR                directory the archive is written to
#
# The archive path is printed on stdout. A sibling `<archive>.sha256` holds the
# archive digest. See infra/scripts/restore.sh and docs/operations/backup.md.
set -euo pipefail

WICKMAIL_DB="${WICKMAIL_DB:-/var/lib/wickmail/wickmail.db}"
WICKMAIL_MAIL_DIR="${WICKMAIL_MAIL_DIR:-/var/vmail}"
WICKMAIL_QUARANTINE_DIR="${WICKMAIL_QUARANTINE_DIR:-/var/vmail-quarantine}"
WICKMAIL_SPOOL_DIR="${WICKMAIL_SPOOL_DIR:-/var/lib/wickmail/spool}"
WICKMAIL_CONFIG_DIR="${WICKMAIL_CONFIG_DIR:-/etc/wickmail}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/wickmail}"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "backup: missing required command: $1" >&2
    exit 1
  fi
}

require sqlite3
require tar
require sha256sum
require date

if [ ! -f "$WICKMAIL_DB" ]; then
  echo "backup: database not found: $WICKMAIL_DB" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

mkdir -p "$staging/db" "$staging/config"

# A consistent snapshot of the live database.
sqlite3 "$WICKMAIL_DB" ".backup '$staging/db/wickmail.db'"

copy_tree() {
  local source="$1" destination="$2"
  if [ -d "$source" ]; then
    mkdir -p "$destination"
    cp -a "$source/." "$destination/"
  fi
}

copy_tree "$WICKMAIL_MAIL_DIR" "$staging/mail"
copy_tree "$WICKMAIL_QUARANTINE_DIR" "$staging/quarantine"
copy_tree "$WICKMAIL_SPOOL_DIR" "$staging/spool"
copy_tree "$WICKMAIL_CONFIG_DIR" "$staging/config"

cat > "$staging/manifest.txt" <<EOF
format=wickmail-backup-v1
created_at=$timestamp
database=$WICKMAIL_DB
mail_dir=$WICKMAIL_MAIL_DIR
quarantine_dir=$WICKMAIL_QUARANTINE_DIR
spool_dir=$WICKMAIL_SPOOL_DIR
config_dir=$WICKMAIL_CONFIG_DIR
EOF

archive="$BACKUP_DIR/wickmail-backup-$timestamp.tar.gz"
tar -czf "$archive" -C "$staging" .
sha256sum "$archive" | awk '{print $1}' > "$archive.sha256"

echo "$archive"
