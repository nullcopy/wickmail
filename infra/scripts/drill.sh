#!/usr/bin/env bash
#
# Run the backup -> restore -> reconciliation drill.
#
# The drill is an automated integration test that drives the real
# infra/scripts/backup.sh and infra/scripts/restore.sh against a temporary
# SQLite database, mail store, and configuration. It then runs reconciliation
# and asserts that the restored state is repaired. Running it through the Nix
# development shell matches CI.
#
# Usage:
#   infra/scripts/drill.sh
#
# See docs/operations/backup.md for the recorded procedure and result.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec nix develop -c npm test --workspace wickmail-server -- backup-restore-drill
