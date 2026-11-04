#!/usr/bin/env bash
#
# Collect Wickmail mail-path health signals, evaluate thresholds, and send
# alerts to a real destination (journald and/or a webhook).
#
# Signals, matching the mail server design's reliability requirements:
#   - SMTP queue depth (Postfix)
#   - durable spool depth and oldest-entry age
#   - disk usage for the state and mail trees
#   - TLS certificate expiry
#   - management authentication failures
#   - policy-service failures and spool failures (process counters)
#   - reconciliation results (repairs, failures)
#
# The process counters and reconciliation results come from the server's
# periodic `wickmail: metrics ...` journal line. Authentication failures and
# reconciliation failures are counted from `wickmail: alert [...]` and
# maintenance log lines in the same lookback window.
#
# Usage: wickmail-monitor [options]
#   --unit NAME               systemd unit to read (default wickmail.service)
#   --state-dir DIR           Server state directory (default /var/lib/wickmail)
#   --spool-dir DIR           Spool directory (default <state-dir>/spool)
#   --mail-root DIR           Maildir root (default /var/vmail)
#   --certificate FILE        TLS certificate to check for expiry (optional)
#   --webhook URL             POST alerts as JSON to this URL (optional)
#   --no-journald             Do not log alerts to journald
#   --lookback SECONDS        Journal lookback window (default 900)
#   --max-spool-depth N       Alert above this depth (default 1000)
#   --max-spool-age SECONDS   Alert above this oldest-entry age (default 3600)
#   --max-disk-percent N      Alert above this disk usage (default 90)
#   --min-cert-days N         Alert below this many days to expiry (default 14)
#   --max-auth-failures N     Alert above this many failures in the window (default 20)
#   --textfile FILE           Write Prometheus textfile-collector metrics here
#   --print                   Print a human-readable summary
#   --json                    Print a JSON summary
#   --quiet                   Print nothing on success
#   -h, --help                Show this help
set -euo pipefail

UNIT=wickmail.service
STATE_DIR=/var/lib/wickmail
SPOOL_DIR=
MAIL_ROOT=/var/vmail
CERTIFICATE=
WEBHOOK=
USE_JOURNALD=1
LOOKBACK=900
MAX_SPOOL_DEPTH=1000
MAX_SPOOL_AGE=3600
MAX_DISK_PERCENT=90
MIN_CERT_DAYS=14
MAX_AUTH_FAILURES=20
TEXTFILE=
PRINT=0
JSON=0
QUIET=0

die() {
  printf 'wickmail-monitor: %s\n' "$*" >&2
  exit 2
}

usage() {
  sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --unit) UNIT=$2; shift 2 ;;
    --state-dir) STATE_DIR=$2; shift 2 ;;
    --spool-dir) SPOOL_DIR=$2; shift 2 ;;
    --mail-root) MAIL_ROOT=$2; shift 2 ;;
    --certificate) CERTIFICATE=$2; shift 2 ;;
    --webhook) WEBHOOK=$2; shift 2 ;;
    --no-journald) USE_JOURNALD=0; shift ;;
    --lookback) LOOKBACK=$2; shift 2 ;;
    --max-spool-depth) MAX_SPOOL_DEPTH=$2; shift 2 ;;
    --max-spool-age) MAX_SPOOL_AGE=$2; shift 2 ;;
    --max-disk-percent) MAX_DISK_PERCENT=$2; shift 2 ;;
    --min-cert-days) MIN_CERT_DAYS=$2; shift 2 ;;
    --max-auth-failures) MAX_AUTH_FAILURES=$2; shift 2 ;;
    --textfile) TEXTFILE=$2; shift 2 ;;
    --print) PRINT=1; shift ;;
    --json) JSON=1; shift ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$SPOOL_DIR" ] || SPOOL_DIR="$STATE_DIR/spool"

alerts=()
metrics_line=
auth_failures=0
reconciliation_errors=0
service_active=1
smtp_queue_depth=0
spool_depth=0
spool_age=0
spool_age_known=0
disk_percent=0
cert_days=-1
policy_failures=0
spool_full=0
spool_unavailable=0
forwarding_failures=0
reconciliations=0
reconciliation_repairs=0
reconciliation_failures=0

add_alert() {
  alerts+=("$1")
}

json_array() {
  if [ "$#" -eq 0 ]; then
    printf '[]'
    return
  fi
  printf '%s\n' "$@" | awk 'BEGIN{printf "["} {gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); printf "%s\"%s\"", (NR>1?",":""), $0} END{printf "]"}'
}

# --- Service state -----------------------------------------------------------

if command -v systemctl >/dev/null 2>&1; then
  if ! systemctl is-active --quiet "$UNIT"; then
    service_active=0
    add_alert "service $UNIT is not active"
  fi
fi

# --- SMTP queue depth --------------------------------------------------------

if command -v postqueue >/dev/null 2>&1; then
  smtp_queue_depth=$(postqueue -j 2>/dev/null | wc -l | tr -d ' ' || printf '0')
fi

# --- Durable spool -----------------------------------------------------------

if command -v wickmail-server >/dev/null 2>&1 && [ -d "$SPOOL_DIR" ]; then
  stats=$(wickmail-server spool-stats --dir "$SPOOL_DIR" 2>/dev/null || true)
  depth=$(printf '%s' "$stats" | sed -n 's/.*depth=\([0-9]*\).*/\1/p')
  age=$(printf '%s' "$stats" | sed -n 's/.*oldest_age_seconds=\([0-9]*\).*/\1/p')
  [ -n "$depth" ] && spool_depth=$depth
  if [ -n "$age" ]; then
    spool_age=$age
    spool_age_known=1
  fi
fi

if [ "$spool_depth" -gt "$MAX_SPOOL_DEPTH" ]; then
  add_alert "spool depth $spool_depth exceeds $MAX_SPOOL_DEPTH"
fi
if [ "$spool_age_known" -eq 1 ] && [ "$spool_age" -gt "$MAX_SPOOL_AGE" ]; then
  add_alert "oldest spool entry is ${spool_age}s old (limit ${MAX_SPOOL_AGE}s)"
fi

# --- Disk usage --------------------------------------------------------------

max_disk_for() {
  [ -d "$1" ] || return 0
  df -P "$1" | awk 'NR==2 {gsub(/%/,"",$5); print $5}'
}

for dir in "$STATE_DIR" "$MAIL_ROOT"; do
  percent=$(max_disk_for "$dir" || true)
  if [ -n "${percent:-}" ] && [ "$percent" -gt "$disk_percent" ]; then
    disk_percent=$percent
  fi
done
if [ "$disk_percent" -gt "$MAX_DISK_PERCENT" ]; then
  add_alert "disk usage ${disk_percent}% exceeds ${MAX_DISK_PERCENT}%"
fi

# --- Certificate expiry ------------------------------------------------------

if [ -n "$CERTIFICATE" ]; then
  if [ -r "$CERTIFICATE" ] && command -v openssl >/dev/null 2>&1; then
    end=$(openssl x509 -enddate -noout -in "$CERTIFICATE" 2>/dev/null | cut -d= -f2 || true)
    if [ -n "$end" ]; then
      end_epoch=$(date -d "$end" +%s 2>/dev/null || printf '')
      if [ -n "$end_epoch" ]; then
        cert_days=$(( (end_epoch - $(date +%s)) / 86400 ))
        if [ "$cert_days" -lt "$MIN_CERT_DAYS" ]; then
          add_alert "certificate expires in ${cert_days} days (minimum ${MIN_CERT_DAYS})"
        fi
      fi
    else
      add_alert "certificate $CERTIFICATE could not be parsed"
    fi
  else
    add_alert "certificate $CERTIFICATE is not readable"
  fi
fi

# --- Journal signals ---------------------------------------------------------

journal_available=0
if command -v journalctl >/dev/null 2>&1; then
  journal=$(journalctl -u "$UNIT" --since "-${LOOKBACK} seconds" --no-pager 2>/dev/null || true)
  if [ -n "$journal" ]; then
    journal_available=1
    metrics_line=$(printf '%s\n' "$journal" | grep -F 'wickmail: metrics' | tail -n1 || true)
    auth_failures=$(printf '%s\n' "$journal" | grep -cF 'alert [authentication_failure]' || true)
    reconciliation_errors=$(printf '%s\n' "$journal" | grep -cF 'quarantine maintenance failed' || true)
  fi
fi

metric_value() {
  printf '%s' "$metrics_line" | grep -oE "$1=[0-9]+" | tail -n1 | cut -d= -f2
}

if [ -n "$metrics_line" ]; then
  policy_failures=$(metric_value policy_failures)
  spool_full=$(metric_value spool_full)
  spool_unavailable=$(metric_value spool_unavailable)
  forwarding_failures=$(metric_value forwarding_failures)
  reconciliations=$(metric_value reconciliations)
  reconciliation_repairs=$(metric_value reconciliation_repairs)
  reconciliation_failures=$(metric_value reconciliation_failures)
  : "${policy_failures:=0}" "${spool_full:=0}" "${spool_unavailable:=0}"
  : "${forwarding_failures:=0}" "${reconciliations:=0}"
  : "${reconciliation_repairs:=0}" "${reconciliation_failures:=0}"
fi

if [ "$auth_failures" -gt "$MAX_AUTH_FAILURES" ]; then
  add_alert "authentication failures ${auth_failures} exceed ${MAX_AUTH_FAILURES} in ${LOOKBACK}s"
fi
if [ "$spool_full" -gt 0 ]; then
  add_alert "spool rejected $spool_full messages as full"
fi
if [ "$spool_unavailable" -gt 0 ]; then
  add_alert "spool was unavailable for $spool_unavailable messages"
fi
if [ "$reconciliation_failures" -gt 0 ] || [ "$reconciliation_errors" -gt 0 ]; then
  add_alert "reconciliation failed ($reconciliation_failures counter, $reconciliation_errors journal lines)"
fi
if [ "$reconciliation_repairs" -gt 0 ]; then
  add_alert "reconciliation repaired a store $reconciliation_repairs times"
fi

# --- Emit --------------------------------------------------------------------

alert_count=${#alerts[@]}

if [ "$USE_JOURNALD" -eq 1 ] && command -v logger >/dev/null 2>&1; then
  if [ "$alert_count" -gt 0 ]; then
    for message in "${alerts[@]}"; do
      logger -t wickmail-monitor -p daemon.warning "ALERT: $message"
    done
  else
    logger -t wickmail-monitor -p daemon.info "ok: all checks within thresholds"
  fi
fi

if [ -n "$WEBHOOK" ] && command -v curl >/dev/null 2>&1 && [ "$alert_count" -gt 0 ]; then
  payload=$(json_array "${alerts[@]}")
  curl -fsS -m 15 -X POST -H 'Content-Type: application/json' \
    --data "{\"source\":\"wickmail-monitor\",\"unit\":\"$UNIT\",\"alerts\":$payload}" \
    "$WEBHOOK" >/dev/null 2>&1 \
    || printf 'wickmail-monitor: webhook POST failed\n' >&2
fi

if [ -n "$TEXTFILE" ]; then
  tmp="$TEXTFILE.tmp"
  {
    printf '# HELP wickmail_spool_depth Messages waiting to be forwarded.\n'
    printf '# TYPE wickmail_spool_depth gauge\n'
    printf 'wickmail_spool_depth %s\n' "$spool_depth"
    printf '# HELP wickmail_spool_oldest_age_seconds Age of the oldest spooled message.\n'
    printf '# TYPE wickmail_spool_oldest_age_seconds gauge\n'
    printf 'wickmail_spool_oldest_age_seconds %s\n' "$spool_age"
    printf '# HELP wickmail_smtp_queue_depth Postfix queue entries.\n'
    printf '# TYPE wickmail_smtp_queue_depth gauge\n'
    printf 'wickmail_smtp_queue_depth %s\n' "$smtp_queue_depth"
    printf '# HELP wickmail_disk_used_percent Highest disk usage of the state and mail trees.\n'
    printf '# TYPE wickmail_disk_used_percent gauge\n'
    printf 'wickmail_disk_used_percent %s\n' "$disk_percent"
    printf '# HELP wickmail_certificate_days_remaining Days until the TLS certificate expires.\n'
    printf '# TYPE wickmail_certificate_days_remaining gauge\n'
    printf 'wickmail_certificate_days_remaining %s\n' "$cert_days"
    printf '# HELP wickmail_auth_failures Authentication failures in the lookback window.\n'
    printf '# TYPE wickmail_auth_failures gauge\n'
    printf 'wickmail_auth_failures %s\n' "$auth_failures"
    printf '# HELP wickmail_policy_failures Delivery policy failures (process lifetime).\n'
    printf '# TYPE wickmail_policy_failures counter\n'
    printf 'wickmail_policy_failures %s\n' "$policy_failures"
    printf '# HELP wickmail_spool_full_total Messages rejected because the spool was full.\n'
    printf '# TYPE wickmail_spool_full_total counter\n'
    printf 'wickmail_spool_full_total %s\n' "$spool_full"
    printf '# HELP wickmail_spool_unavailable_total Messages rejected because the spool was unavailable.\n'
    printf '# TYPE wickmail_spool_unavailable_total counter\n'
    printf 'wickmail_spool_unavailable_total %s\n' "$spool_unavailable"
    printf '# HELP wickmail_forwarding_failures_total Spool entries that failed to forward.\n'
    printf '# TYPE wickmail_forwarding_failures_total counter\n'
    printf 'wickmail_forwarding_failures_total %s\n' "$forwarding_failures"
    printf '# HELP wickmail_reconciliations_total Completed reconciliation passes.\n'
    printf '# TYPE wickmail_reconciliations_total counter\n'
    printf 'wickmail_reconciliations_total %s\n' "$reconciliations"
    printf '# HELP wickmail_reconciliation_repairs_total Reconciliation passes that repaired a store.\n'
    printf '# TYPE wickmail_reconciliation_repairs_total counter\n'
    printf 'wickmail_reconciliation_repairs_total %s\n' "$reconciliation_repairs"
    printf '# HELP wickmail_reconciliation_failures_total Reconciliation passes that failed.\n'
    printf '# TYPE wickmail_reconciliation_failures_total counter\n'
    printf 'wickmail_reconciliation_failures_total %s\n' "$reconciliation_failures"
    printf '# HELP wickmail_alerts_total Alerts raised by this run.\n'
    printf '# TYPE wickmail_alerts_total gauge\n'
    printf 'wickmail_alerts_total %s\n' "$alert_count"
  } > "$tmp"
  mv "$tmp" "$TEXTFILE"
fi

if [ "$PRINT" -eq 1 ]; then
  printf 'wickmail monitor: unit=%s active=%s\n' "$UNIT" "$service_active"
  printf '  smtp_queue_depth=%s spool_depth=%s spool_oldest_age=%s\n' \
    "$smtp_queue_depth" "$spool_depth" "$( [ "$spool_age_known" -eq 1 ] && printf '%ss' "$spool_age" || printf 'none' )"
  printf '  disk_used_percent=%s certificate_days=%s\n' "$disk_percent" "$cert_days"
  printf '  auth_failures=%s policy_failures=%s spool_full=%s spool_unavailable=%s forwarding_failures=%s\n' \
    "$auth_failures" "$policy_failures" "$spool_full" "$spool_unavailable" "$forwarding_failures"
  printf '  reconciliations=%s repairs=%s failures=%s\n' \
    "$reconciliations" "$reconciliation_repairs" "$reconciliation_failures"
  if [ "$alert_count" -gt 0 ]; then
    printf '  alerts:\n'
    for message in "${alerts[@]}"; do
      printf '    - %s\n' "$message"
    done
  else
    printf '  alerts: none\n'
  fi
fi

if [ "$JSON" -eq 1 ]; then
  alerts_json=$(json_array "${alerts[@]}")
  printf '{"unit":"%s","active":%s,"smtpQueueDepth":%s,"spoolDepth":%s,"spoolOldestAgeSeconds":%s,"diskUsedPercent":%s,"certificateDays":%s,"authFailures":%s,"policyFailures":%s,"spoolFull":%s,"spoolUnavailable":%s,"forwardingFailures":%s,"reconciliations":%s,"reconciliationRepairs":%s,"reconciliationFailures":%s,"alerts":%s}\n' \
    "$UNIT" "$service_active" "$smtp_queue_depth" "$spool_depth" "$spool_age" "$disk_percent" "$cert_days" \
    "$auth_failures" "$policy_failures" "$spool_full" "$spool_unavailable" "$forwarding_failures" \
    "$reconciliations" "$reconciliation_repairs" "$reconciliation_failures" "$alerts_json"
fi

if [ "$alert_count" -gt 0 ]; then
  if [ "$QUIET" -eq 0 ] && [ "$PRINT" -eq 0 ] && [ "$JSON" -eq 0 ]; then
    for message in "${alerts[@]}"; do
      printf 'wickmail-monitor: ALERT: %s\n' "$message" >&2
    done
  fi
  exit 1
fi

exit 0
