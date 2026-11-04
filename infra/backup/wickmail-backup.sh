#!/usr/bin/env bash
#
# Back up the Wickmail mail store, SQLite alias database, and configuration
# into a single timestamped archive.
#
# The alias database is snapshotted with `sqlite3 .backup`, which is safe to
# run while the server holds the database open. The mail store is a Maildir,
# which tolerates a concurrent copy. Configuration (DKIM keys, TLS material,
# and any host-supplied files) is copied verbatim.
#
# The archive layout is:
#
#   wickmail.sqlite            transactional snapshot of the alias database
#   spool/                     durable inbound spool
#   outbound/                  queued outbound replies
#   mail/                      Maildir root (Inbox and quarantine)
#   config/                    configuration directory, when provided
#   MANIFEST                   provenance, versions, and checksums
#
# Usage: wickmail-backup [options]
#   --state-dir DIR       Server state directory (default /var/lib/wickmail)
#   --mail-root DIR       Maildir root (default /var/vmail)
#   --config-dir DIR      Configuration directory to include (optional)
#   --output DIR          Backup destination (default /var/backup/wickmail)
#   --label NAME          Backup label (default: UTC timestamp)
#   --retention N         Keep the newest N archives; 0 disables pruning (default 14)
#   --metadata-only       Skip the mail store
#   --quiet               Suppress progress output
#   -h, --help            Show this help
set -euo pipefail

STATE_DIR=/var/lib/wickmail
MAIL_ROOT=/var/vmail
CONFIG_DIR=
OUTPUT=/var/backup/wickmail
LABEL=
RETENTION=14
INCLUDE_MAIL=1
QUIET=0

log() {
  if [ "$QUIET" -eq 0 ]; then
    printf '%s\n' "$*" >&2
  fi
}

die() {
  printf 'wickmail-backup: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --state-dir) STATE_DIR=$2; shift 2 ;;
    --mail-root) MAIL_ROOT=$2; shift 2 ;;
    --config-dir) CONFIG_DIR=$2; shift 2 ;;
    --output) OUTPUT=$2; shift 2 ;;
    --label) LABEL=$2; shift 2 ;;
    --retention) RETENTION=$2; shift 2 ;;
    --metadata-only) INCLUDE_MAIL=0; shift ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -d "$STATE_DIR" ] || die "state directory not found: $STATE_DIR"
[ -f "$STATE_DIR/wickmail.sqlite" ] || die "database not found: $STATE_DIR/wickmail.sqlite"
if [ "$INCLUDE_MAIL" -eq 1 ]; then
  [ -d "$MAIL_ROOT" ] || die "mail root not found: $MAIL_ROOT"
fi
if [ -n "$CONFIG_DIR" ]; then
  [ -d "$CONFIG_DIR" ] || die "config directory not found: $CONFIG_DIR"
fi

if [ -z "$LABEL" ]; then
  LABEL=$(date -u +%Y%m%dT%H%M%SZ)
fi

mkdir -p "$OUTPUT"
STAGING=$(mktemp -d "${TMPDIR:-/tmp}/wickmail-backup.XXXXXX")
cleanup() { rm -rf "$STAGING"; }
trap cleanup EXIT

log "wickmail-backup: staging in $STAGING"

# A consistent database snapshot, even while the server is running.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$STATE_DIR/wickmail.sqlite" ".backup '$STAGING/wickmail.sqlite'"
else
  die "sqlite3 is required to snapshot the database consistently"
fi

for sub in spool outbound; do
  if [ -d "$STATE_DIR/$sub" ]; then
    mkdir -p "$STAGING/$sub"
    cp -a "$STATE_DIR/$sub/." "$STAGING/$sub/"
  fi
done

if [ "$INCLUDE_MAIL" -eq 1 ]; then
  mkdir -p "$STAGING/mail"
  cp -a "$MAIL_ROOT/." "$STAGING/mail/"
fi

if [ -n "$CONFIG_DIR" ]; then
  mkdir -p "$STAGING/config"
  cp -a "$CONFIG_DIR/." "$STAGING/config/"
fi

SERVER_VERSION=$(wickmail-server version 2>/dev/null || printf 'unknown')
SCHEMA_VERSION=$(sqlite3 "$STAGING/wickmail.sqlite" 'PRAGMA user_version;' 2>/dev/null || printf 'unknown')
DB_SUM=$(sha256sum "$STAGING/wickmail.sqlite" | awk '{print $1}')

{
  printf 'format: wickmail-backup/1\n'
  printf 'label: %s\n' "$LABEL"
  printf 'created_at: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'hostname: %s\n' "$(uname -n)"
  printf 'server_version: %s\n' "$SERVER_VERSION"
  printf 'schema_version: %s\n' "$SCHEMA_VERSION"
  printf 'database_sha256: %s\n' "$DB_SUM"
  printf 'included_mail: %s\n' "$INCLUDE_MAIL"
  printf 'state_dir: %s\n' "$STATE_DIR"
  printf 'mail_root: %s\n' "$MAIL_ROOT"
  printf 'config_dir: %s\n' "$CONFIG_DIR"
} > "$STAGING/MANIFEST"

ARCHIVE="$OUTPUT/wickmail-backup-$LABEL.tar.gz"
TMP_ARCHIVE="$ARCHIVE.tmp"
log "wickmail-backup: writing $ARCHIVE"
tar -czf "$TMP_ARCHIVE" -C "$STAGING" .
mv "$TMP_ARCHIVE" "$ARCHIVE"
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
log "wickmail-backup: wrote $(du -h "$ARCHIVE" | awk '{print $1}')"

if [ "$RETENTION" -gt 0 ]; then
  # Keep the newest $RETENTION archives and remove older ones with their
  # checksum sidecars.
  ls -1t "$OUTPUT"/wickmail-backup-*.tar.gz 2>/dev/null \
    | tail -n "+$((RETENTION + 1))" \
    | while IFS= read -r stale; do
        log "wickmail-backup: pruning $stale"
        rm -f "$stale" "$stale.sha256"
      done
fi

printf '%s\n' "$ARCHIVE"
