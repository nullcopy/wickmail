#!/usr/bin/env bash
#
# Write the current Postfix queue to a file the Wickmail server reads for the
# `wickmail_smtp_queue_depth` gauge.
#
# Run this from a systemd timer (or cron) on the mail host. The server reads
# `WICKMAIL_POSTFIX_QUEUE_FILE` on every `/metrics` scrape, so the file only
# needs to be refreshed at the same cadence as the scrape.
#
# Environment:
#   WICKMAIL_POSTFIX_QUEUE_FILE  output file (default /var/lib/wickmail/postfix-queue.jsonl)
set -euo pipefail

output="${WICKMAIL_POSTFIX_QUEUE_FILE:-/var/lib/wickmail/postfix-queue.jsonl}"

if ! command -v postqueue >/dev/null 2>&1; then
  echo "collect-postfix-queue: postqueue not found" >&2
  exit 1
fi

mkdir -p "$(dirname "$output")"
# Write atomically so the server never reads a partial file.
tmp="$(mktemp "${output}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
postqueue -j > "$tmp"
mv "$tmp" "$output"
