# Monitoring and alerting

The management API exposes Prometheus metrics at `GET /metrics`. The gauges
that describe current state are refreshed from the spool, the filesystem, the
TLS certificate, and the Postfix queue on every scrape, so no background timer
is required.

- Metrics code: [`apps/server/src/metrics`](../../apps/server/src/metrics).
- Endpoint: [`apps/server/src/api/metrics.ts`](../../apps/server/src/api/metrics.ts).
- Alert rules: [`infra/monitoring/alert-rules.yml`](../../infra/monitoring/alert-rules.yml).
- Scrape example: [`infra/monitoring/prometheus.example.yml`](../../infra/monitoring/prometheus.example.yml).
- Postfix queue collector: [`infra/scripts/collect-postfix-queue.sh`](../../infra/scripts/collect-postfix-queue.sh).

## Scraping

The endpoint is on the same listener as the management API. Bind that listener
to a private interface, or set a bearer token so the endpoint requires
authorization:

```nix
services.wickmail.mail.metrics = {
  enable = true;
  diskPaths = [ "/var/lib/wickmail/spool" "/var/vmail" "/var/vmail-quarantine" ];
  certificatePaths = [ "/var/lib/acme/example.com/fullchain.pem" ];
  tokenFile = "/run/keys/wickmail-metrics.env"; # sets WICKMAIL_METRICS_TOKEN
};
```

With a token set, a scrape sends `Authorization: Bearer <token>` and an
unauthenticated request receives `401`. `infra/monitoring/prometheus.example.yml`
shows the matching `authorization.credentials_file` configuration.

## Metric catalogue

| Metric                                          | Type    | Labels   | Meaning                                                       |
| ----------------------------------------------- | ------- | -------- | ------------------------------------------------------------- |
| `wickmail_smtp_queue_depth`                     | gauge   |          | Messages in the Postfix queue.                                |
| `wickmail_spool_depth`                          | gauge   |          | Accepted messages waiting for Dovecot.                        |
| `wickmail_spool_oldest_age_seconds`             | gauge   |          | Age of the oldest spooled message.                            |
| `wickmail_disk_free_bytes`                      | gauge   | `path`   | Free bytes available to the mail service.                     |
| `wickmail_disk_total_bytes`                     | gauge   | `path`   | Filesystem size.                                              |
| `wickmail_disk_free_ratio`                      | gauge   | `path`   | Free space as a fraction.                                     |
| `wickmail_disk_ok`                              | gauge   | `path`   | `1` at or above the free-space floor, `0` below it.           |
| `wickmail_certificate_expiry_timestamp_seconds` | gauge   | `path`   | Certificate not-after time as a Unix timestamp.               |
| `wickmail_certificate_expiry_days`              | gauge   | `path`   | Whole days until the certificate expires.                     |
| `wickmail_auth_failures_total`                  | counter | `method` | Failed management authentication attempts.                    |
| `wickmail_policy_failures_total`                | counter | `stage`  | Recipient policy evaluations that failed (`rcpt`/`delivery`). |
| `wickmail_recipient_rejections_total`           | counter | `reason` | RCPT rejections (`unknown`/`disabled`).                       |
| `wickmail_messages_accepted_total`              | counter | `route`  | Inbound messages accepted into the spool.                     |
| `wickmail_messages_tempfailed_total`            | counter | `stage`  | Inbound messages deferred with a temporary failure.           |
| `wickmail_outbound_tempfailed_total`            | counter | `reason` | Outbound submissions deferred by an abuse control.            |
| `wickmail_reconciliation_runs_total`            | counter |          | Reconciliation passes completed.                              |
| `wickmail_reconciliation_messages_total`        | counter | `result` | Reconciliation outcomes (`recovered`, `requarantined`, ...).  |
| `wickmail_reconciliation_last_scanned`          | gauge   |          | Metadata rows examined by the last pass.                      |
| `wickmail_retention_runs_total`                 | counter |          | Retention passes completed.                                   |
| `wickmail_retention_messages_total`             | counter | `result` | Retention outcomes (`expired`, `quota`, `purged`).            |
| `wickmail_quarantine_entries`                   | gauge   | `status` | Quarantine metadata rows by status.                           |
| `wickmail_alerts_total`                         | counter | `kind`   | Operational alerts emitted.                                   |

The design's required coverage maps as follows:

- **SMTP queue depth** → `wickmail_smtp_queue_depth`.
- **Spool depth and age** → `wickmail_spool_depth`, `wickmail_spool_oldest_age_seconds`.
- **Disk usage** → `wickmail_disk_free_bytes`, `wickmail_disk_free_ratio`, `wickmail_disk_ok`.
- **Certificate expiry** → `wickmail_certificate_expiry_days`, `..._timestamp_seconds`.
- **Authentication failures** → `wickmail_auth_failures_total`.
- **Policy-service failures** → `wickmail_policy_failures_total`.
- **Reconciliation results** → `wickmail_reconciliation_runs_total`,
  `wickmail_reconciliation_messages_total`, `wickmail_reconciliation_last_scanned`.

## Wiring the existing alert hooks

The mail path already emits structured alerts. `MetricsAlertSink` wraps the
configured sink, counts every alert as `wickmail_alerts_total{kind}`, and
forwards it unchanged. The existing hooks now surface as metrics:

- Disk full from the LMTP proxy → `wickmail_alerts_total{kind="disk_full"}`.
- Quota deletions from retention → `wickmail_retention_messages_total{result="quota"}`
  and the per-status `wickmail_quarantine_entries` gauge.
- Spool full → `wickmail_messages_tempfailed_total{stage="spool"}` and
  `wickmail_alerts_total{kind="disk_full"}`.

## Postfix queue depth

On hosts where the server cannot run `postqueue` itself, run
`infra/scripts/collect-postfix-queue.sh` from a timer and point the server at
its output:

```sh
WICKMAIL_POSTFIX_QUEUE_FILE=/var/lib/wickmail/postfix-queue.jsonl \
  infra/scripts/collect-postfix-queue.sh
```

Set `WICKMAIL_POSTFIX_QUEUE_FILE` in the server environment; the server reads
the file on every scrape and sets `wickmail_smtp_queue_depth`.

## Alert rules

`infra/monitoring/alert-rules.yml` groups rules as follows. Load it with a
Prometheus `rule_files` entry.

| Alert                             | Condition                                  |
| --------------------------------- | ------------------------------------------ |
| `WickmailSmtpQueueDepthHigh`      | Queue depth above 100 for 15m.             |
| `WickmailSpoolDepthHigh`          | Spool depth above 100 for 15m.             |
| `WickmailSpoolOldestMessageStuck` | Oldest spooled message over an hour old.   |
| `WickmailSpoolFullAlerts`         | Any `disk_full` alert in 10m.              |
| `WickmailDiskSpaceLow`            | Free ratio below 10% for 10m.              |
| `WickmailDiskBelowFloor`          | `wickmail_disk_ok == 0` for 5m.            |
| `WickmailCertificateExpiringSoon` | Fewer than 14 days to expiry.              |
| `WickmailAuthenticationFailures`  | More than 20 auth failures in 5m.          |
| `WickmailRecipientRejections`     | More than 500 RCPT rejections in 10m.      |
| `WickmailPolicyServiceFailures`   | Any policy failure in 5m.                  |
| `WickmailOutboundRateLimited`     | Any outbound rate-limit deferral in 10m.   |
| `WickmailReconciliationRepairs`   | Reconciliation repaired any message in 1h. |

## Tests

`apps/server/test/metrics.test.ts` covers the registry and exposition format,
certificate expiry, the queue probe, the collectors, the alert sink, mail-path
counters, the `/metrics` route, and the bearer-token guard.
`apps/server/test/server-process.test.ts` composes the full process from the
environment and scrapes `/metrics`.
