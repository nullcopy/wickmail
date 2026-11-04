# Monitoring and alerting

The mail server design requires monitoring for SMTP queue depth, spool depth
and age, disk usage, certificate expiry, authentication failures,
policy-service failures, and reconciliation results. Wickmail covers all of
them with `wickmail-monitor`, a NixOS timer, and optional Prometheus
integration.

## Signals

| Signal | Source | Threshold option |
|---|---|---|
| SMTP queue depth | `postqueue -j` | reported, no default alert |
| Spool depth | `wickmail-server spool-stats` | `monitoring.maxSpoolDepth` |
| Spool oldest-entry age | `wickmail-server spool-stats` | `monitoring.maxSpoolAgeSeconds` |
| Disk usage | `df` on the state and mail trees | `monitoring.maxDiskPercent` |
| Certificate expiry | `openssl x509` on `monitoring.certificateFile` | `monitoring.minCertificateDays` |
| Authentication failures | `wickmail: alert [authentication_failure]` journal lines | `monitoring.maxAuthFailures` |
| Policy-service failures | `policy_failures` counter in the metrics line | reported |
| Spool failures | `spool_full`, `spool_unavailable`, `forwarding_failures` counters | reported |
| Reconciliation results | `reconciliations`, `reconciliation_repairs`, `reconciliation_failures` counters and maintenance log lines | repairs and failures alert |

The server logs a `wickmail: metrics ...` line whenever a counter changes, and
a reconciliation pass increments `reconciliations` on every maintenance
interval, so the line is also a liveness signal. Authentication failures and
reconciliation failures are counted from the journal in a lookback window.

## Configuration

```nix
services.wickmail.monitoring = {
  enable = true;
  interval = "5min";
  webhookUrl = "https://alerts.example.com/hooks/wickmail"; # optional
  textfile = "/var/lib/node-exporter/textfile/wickmail.prom"; # optional
  maxSpoolDepth = 1000;
  maxSpoolAgeSeconds = 3600;
  maxDiskPercent = 90;
  minCertificateDays = 14;
  maxAuthFailures = 20;
};
```

Enabling monitoring installs `wickmail-monitor.timer`, which runs
`wickmail-monitor` every `interval`. The check runs as root because it reads
the mail store and the server state. A run with alerts exits non-zero, so it
appears in `systemctl --failed`.

## Alert destinations

- **journald.** Every alert is written with `logger -t wickmail-monitor -p
  daemon.warning`. A clean run logs an `ok` line at info level. Query with
  `journalctl -t wickmail-monitor`.
- **Webhook.** When `webhookUrl` is set, alerts are POSTed as JSON:
  ```json
  {"source":"wickmail-monitor","unit":"wickmail.service","alerts":["spool depth 1200 exceeds 1000"]}
  ```
- **Prometheus.** When `textfile` is set, the run writes gauges and counters
  for a node-exporter textfile collector. See
  [`infra/monitoring/prometheus-alerts.yml`](../../infra/monitoring/prometheus-alerts.yml)
  for ready-to-load alert rules.

## Operating it

```console
# Show the current state without sending alerts.
wickmail-monitor --print

# Emit the JSON summary (useful from scripts).
wickmail-monitor --json --no-journald

# Run one check by hand.
systemctl start wickmail-monitor.service

# Recent alerts.
journalctl -t wickmail-monitor -p warning --since "24 hours ago"
```

## Failure mapping

| Condition | Signal | Action |
|---|---|---|
| Spool growing | `wickmail_spool_depth` rises | Investigate Dovecot or the LMTP path |
| Spool stalled | `wickmail_spool_oldest_age_seconds` rises | Check `wickmail.service` and the journal |
| Disk nearly full | `wickmail_disk_used_percent` | Free space; the server returns temporary failures and never drops accepted mail |
| Certificate expiring | `wickmail_certificate_days_remaining` | Renew the ACME certificate |
| Brute-force authentication | `wickmail_auth_failures` | Review the source and rotate credentials |
| Policy or database outage | `wickmail_policy_failures` rises | Check the database and `wickmail.service` |
| Spool rejected mail | `wickmail_spool_full_total` / `wickmail_spool_unavailable_total` | Free space or raise `maxSpoolEntries` |
| Reconciliation repaired a store | `wickmail_reconciliation_repairs_total` | Confirm the repair was expected (for example after a restore) |
| Reconciliation failed | `wickmail_reconciliation_failures_total` | Inspect the journal; the mail store may be unavailable |
