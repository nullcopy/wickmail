#!/usr/bin/env bash
#
# Restore a Wickmail backup produced by infra/scripts/backup.sh.
#
# The archive digest is verified when a sibling `<archive>.sha256` exists.
# Existing non-empty destinations and an existing database are only overwritten
# with --force. After a restore, run reconciliation before serving mail; the
# server repairs any metadata the restore left inconsistent with the mail store.
#
# Usage:
#   restore.sh [--force] <archive.tar.gz>
#
# Environment: the same variables as backup.sh, describing where to restore.
set -euo pipefail

usage() {
  echo "usage: restore.sh [--force] <archive.tar.gz>" >&2
  exit 2
}

force=0
if [ "${1:-}" = "--force" ]; then
  force=1
  shift
fi
archive="${1:-}"
if [ -z "$archive" ]; then
  usage
fi
if [ ! -f "$archive" ]; then
  echo "restore: archive not found: $archive" >&2
  exit 1
fi

WICKMAIL_DB="${WICKMAIL_DB:-/var/lib/wickmail/wickmail.db}"
WICKMAIL_MAIL_DIR="${WICKMAIL_MAIL_DIR:-/var/vmail}"
WICKMAIL_QUARANTINE_DIR="${WICKMAIL_QUARANTINE_DIR:-/var/vmail-quarantine}"
WICKMAIL_SPOOL_DIR="${WICKMAIL_SPOOL_DIR:-/var/lib/wickmail/spool}"
WICKMAIL_CONFIG_DIR="${WICKMAIL_CONFIG_DIR:-/etc/wickmail}"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "restore: missing required command: $1" >&2
    exit 1
  fi
}

require tar
require sha256sum
require cp

if [ -f "$archive.sha256" ]; then
  expected="$(tr -d '[:space:]' < "$archive.sha256")"
  actual="$(sha256sum "$archive" | awk '{print $1}')"
  if [ "$expected" != "$actual" ]; then
    echo "restore: checksum mismatch for $archive" >&2
    exit 1
  fi
fi

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
tar -xzf "$archive" -C "$staging"

if [ ! -f "$staging/manifest.txt" ] || ! grep -q '^format=wickmail-backup-v1$' "$staging/manifest.txt"; then
  echo "restore: $archive is not a Wickmail backup" >&2
  exit 1
fi

if [ ! -f "$staging/db/wickmail.db" ]; then
  echo "restore: archive is missing db/wickmail.db" >&2
  exit 1
fi

restore_tree() {
  local source="$1" destination="$2"
  if [ ! -d "$source" ]; then
    return 0
  fi
  if [ "$force" -ne 1 ] && [ -d "$destination" ] && [ -n "$(ls -A "$destination" 2>/dev/null)" ]; then
    echo "restore: refusing to overwrite non-empty $destination (use --force)" >&2
    exit 1
  fi
  mkdir -p "$destination"
  cp -a "$source/." "$destination/"
}

if [ "$force" -ne 1 ] && [ -f "$WICKMAIL_DB" ]; then
  echo "restore: refusing to overwrite existing database $WICKMAIL_DB (use --force)" >&2
  exit 1
fi
mkdir -p "$(dirname "$WICKMAIL_DB")"
cp -a "$staging/db/wickmail.db" "$WICKMAIL_DB"

restore_tree "$staging/mail" "$WICKMAIL_MAIL_DIR"
restore_tree "$staging/quarantine" "$WICKMAIL_QUARANTINE_DIR"
restore_tree "$staging/spool" "$WICKMAIL_SPOOL_DIR"
restore_tree "$staging/config" "$WICKMAIL_CONFIG_DIR"

echo "restored $archive" >&2
echo "next: reconcile before serving mail (see docs/operations/backup.md)" >&2
