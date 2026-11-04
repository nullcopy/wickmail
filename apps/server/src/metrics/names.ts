/**
 * The metric names and help text Wickmail exposes, in one place so the
 * collectors, the mail path, and the management API agree.
 *
 * Every name is prefixed with `wickmail_` and every unit is a base unit
 * (seconds, bytes) as Prometheus conventions require.
 */
export const METRIC = {
  alertsTotal: {
    name: "wickmail_alerts_total",
    help: "Operational alerts emitted, by kind.",
  },
  messagesAcceptedTotal: {
    name: "wickmail_messages_accepted_total",
    help: "Inbound messages accepted into the spool, by delivery route.",
  },
  messagesTempfailedTotal: {
    name: "wickmail_messages_tempfailed_total",
    help: "Inbound messages deferred with a temporary failure, by stage.",
  },
  authFailuresTotal: {
    name: "wickmail_auth_failures_total",
    help: "Failed management authentication attempts, by method.",
  },
  policyFailuresTotal: {
    name: "wickmail_policy_failures_total",
    help: "Recipient policy evaluations that failed, by stage.",
  },
  recipientRejectionsTotal: {
    name: "wickmail_recipient_rejections_total",
    help: "Recipients rejected at RCPT time, by reason.",
  },
  outboundTempfailedTotal: {
    name: "wickmail_outbound_tempfailed_total",
    help: "Outbound submissions deferred by an abuse control, by reason.",
  },
  reconciliationRunsTotal: {
    name: "wickmail_reconciliation_runs_total",
    help: "Quarantine reconciliation passes completed.",
  },
  reconciliationMessagesTotal: {
    name: "wickmail_reconciliation_messages_total",
    help: "Quarantine reconciliation outcomes, by result.",
  },
  reconciliationLastScanned: {
    name: "wickmail_reconciliation_last_scanned",
    help: "Metadata rows examined by the most recent reconciliation pass.",
  },
  retentionRunsTotal: {
    name: "wickmail_retention_runs_total",
    help: "Quarantine retention passes completed.",
  },
  retentionMessagesTotal: {
    name: "wickmail_retention_messages_total",
    help: "Quarantine retention outcomes, by result.",
  },
  quarantineEntries: {
    name: "wickmail_quarantine_entries",
    help: "Quarantine metadata rows, by status.",
  },
  spoolDepth: {
    name: "wickmail_spool_depth",
    help: "Messages waiting in the durable spool for delivery.",
  },
  spoolOldestAgeSeconds: {
    name: "wickmail_spool_oldest_age_seconds",
    help: "Age of the oldest spooled message in seconds, or 0 when empty.",
  },
  smtpQueueDepth: {
    name: "wickmail_smtp_queue_depth",
    help: "Messages in the Postfix queue, as reported by postqueue.",
  },
  diskFreeBytes: {
    name: "wickmail_disk_free_bytes",
    help: "Free bytes available to the mail service, by path.",
  },
  diskTotalBytes: {
    name: "wickmail_disk_total_bytes",
    help: "Total filesystem bytes, by path.",
  },
  diskFreeRatio: {
    name: "wickmail_disk_free_ratio",
    help: "Free space as a fraction of the filesystem, by path.",
  },
  diskOk: {
    name: "wickmail_disk_ok",
    help: "Whether free space is at or above the floor (1) or below it (0), by path.",
  },
  certificateExpirySeconds: {
    name: "wickmail_certificate_expiry_timestamp_seconds",
    help: "TLS certificate not-after time as a Unix timestamp, by path.",
  },
  certificateExpiryDays: {
    name: "wickmail_certificate_expiry_days",
    help: "Whole days until the TLS certificate expires, by path.",
  },
} as const;
