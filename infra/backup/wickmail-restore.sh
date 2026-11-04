#!/usr/bin/env bash
#
# Restore a Wickmail backup produced by wickmail-backup.
#
# Restore is intentionally explicit: it refuses to overwrite a non-empty
# target unless --force is given, verifies the archive checksum, and can run
# the schema migration and a quarantine reconciliation pass after extraction.
#
# Run this with the mail services stopped (systemctl stop postfix dovecot
# wickmail) so the restored files are not rewritten mid-copy. The mail path
# is idempotent and reconciliation repairs a store that disagrees with the
# database, so a restore that lands while the server is running still
# converges, but a quiesced restore is the supported path.
#
# Usage: wickmail-restore [options]
#   --archive FILE        Backup archive to restore (required)
#   --state-dir DIR       Server state directory (default /var/lib/wickmail)
#   --mail-root DIR       Maildir root (default /var/vmail)
#   --config-dir DIR      Configuration directory to restore into (optional)
#   --state-owner U:G     Ownership for the state tree (default wickmail:wickmail)
#   --mail-owner U:G      Ownership for the mail tree (default vmail:vmail)
#   --reconcile           Run `quarantine reconcile` after restoring
#   --force               Overwrite non-empty target directories
#   --quiet               Suppress progress output
#   -h, --help            Show this help
set -euo pipefail

ARCHIVE=
STATE_DIR=/var/lib/wickmail
MAIL_ROOT=/var/vmail
CONFIG_DIR=
STATE_OWNER=wickmail:wickmail
MAIL_OWNER=vmail:vmail
RECONCILE=0
FORCE=0
QUIET=0

log() {
  if [ "$QUIET" -eq 0 ]; then
    printf '%s\n' "$*" >&2
  fi
}

die() {
  printf 'wickmail-restore: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --archive) ARCHIVE=$2; shift 2 ;;
    --state-dir) STATE_DIR=$2; shift 2 ;;
    --mail-root) MAIL_ROOT=$2; shift 2 ;;
    --config-dir) CONFIG_DIR=$2; shift 2 ;;
    --state-owner) STATE_OWNER=$2; shift 2 ;;
    --mail-owner) MAIL_OWNER=$2; shift 2 ;;
    --reconcile) RECONCILE=1; shift ;;
    --force) FORCE=1; shift ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$ARCHIVE" ] || die "--archive is required"
[ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE"

if [ -f "$ARCHIVE.sha256" ]; then
  log "wickmail-restore: verifying checksum"
  ( cd "$(dirname "$ARCHIVE")" && sha256sum --check --quiet "$(basename "$ARCHIVE.sha256")" ) \
    || die "archive checksum does not match"
fi

STAGING=$(mktemp -d "${TMPDIR:-/tmp}/wickmail-restore.XXXXXX")
cleanup() { rm -rf "$STAGING"; }
trap cleanup EXIT

log "wickmail-restore: extracting $ARCHIVE"
tar -xzf "$ARCHIVE" -C "$STAGING"
[ -f "$STAGING/MANIFEST" ] || die "archive is missing MANIFEST"
[ -f "$STAGING/wickmail.sqlite" ] || die "archive is missing wickmail.sqlite"

require_empty() {
  target=$1
  if [ -d "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ] && [ "$FORCE" -eq 0 ]; then
    die "target $target is not empty; pass --force to overwrite"
  fi
}

require_empty "$STATE_DIR"
require_empty "$MAIL_ROOT"
if [ -n "$CONFIG_DIR" ]; then
  require_empty "$CONFIG_DIR"
fi

mkdir -p "$STATE_DIR" "$STATE_DIR/spool" "$STATE_DIR/outbound"
install -m 0640 "$STAGING/wickmail.sqlite" "$STATE_DIR/wickmail.sqlite"
for sub in spool outbound; do
  if [ -d "$STAGING/$sub" ]; then
    mkdir -p "$STATE_DIR/$sub"
    cp -a "$STAGING/$sub/." "$STATE_DIR/$sub/"
  fi
done

if [ -d "$STAGING/mail" ]; then
  mkdir -p "$MAIL_ROOT"
  cp -a "$STAGING/mail/." "$MAIL_ROOT/"
fi

if [ -n "$CONFIG_DIR" ] && [ -d "$STAGING/config" ]; then
  mkdir -p "$CONFIG_DIR"
  cp -a "$STAGING/config/." "$CONFIG_DIR/"
fi

if command -v chown >/dev/null 2>&1; then
  chown -R "$STATE_OWNER" "$STATE_DIR" 2>/dev/null || true
  if [ -d "$MAIL_ROOT" ]; then
    chown -R "$MAIL_OWNER" "$MAIL_ROOT" 2>/dev/null || true
  fi
fi

if command -v wickmail-server >/dev/null 2>&1; then
  log "wickmail-restore: migrating the restored database"
  wickmail-server migrate "$STATE_DIR/wickmail.sqlite"
  if [ "$RECONCILE" -eq 1 ]; then
    log "wickmail-restore: reconciling quarantine against the mail store"
    wickmail-server quarantine reconcile \
      --db "$STATE_DIR/wickmail.sqlite" \
      --maildir "$MAIL_ROOT/Maildir" \
      --quarantine-dir "$MAIL_ROOT/quarantine/.Expired"
  fi
fi

log "wickmail-restore: restore complete"
log "next: start services (systemctl start wickmail dovecot postfix) and verify with 'wickmail-monitor --print'"
