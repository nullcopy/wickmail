import { checkDiskSpace } from "../abuse/disk.js";
import type { SqliteDatabase } from "../db/database.js";
import { listQuarantineEntries } from "../quarantine/repository.js";
import type { Spool } from "../spool/types.js";
import { certificateExpiry } from "./certificate.js";
import { METRIC } from "./names.js";
import { readPostfixQueueDepth, type PostfixQueueProbeOptions } from "./postfix.js";
import type { MetricsRegistry } from "./registry.js";

/** One day in seconds, for the certificate-expiry gauge. */
const DAY_SECONDS = 24 * 60 * 60;

/** Options for {@link collectOperationalMetrics}. */
export interface OperationalMetricsOptions {
  /** The durable spool whose depth and age are reported. */
  spool?: Spool;
  /** The reference time in epoch milliseconds. */
  now: number;
  /** Filesystem paths whose free space is reported. */
  diskPaths?: readonly string[];
  /** Free-space floor used for the `wickmail_disk_ok` gauge. */
  minFreeBytes?: number;
  /** PEM certificate paths whose expiry is reported. */
  certificatePaths?: readonly string[];
  /** Postfix queue probe configuration, or `false` to skip it. */
  postfixQueue?: PostfixQueueProbeOptions | false;
}

/**
 * Refresh the pull-based gauges: spool depth and age, disk usage, certificate
 * expiry, and the SMTP queue depth.
 *
 * The management API calls this immediately before it renders `/metrics`, so a
 * scrape always observes current values without a background timer. Counters
 * are updated by the code that handles the event, not here.
 */
export async function collectOperationalMetrics(
  registry: MetricsRegistry,
  options: OperationalMetricsOptions,
): Promise<void> {
  const { now } = options;

  if (options.spool !== undefined) {
    const stats = await options.spool.stats(now);
    registry.set(METRIC.spoolDepth.name, METRIC.spoolDepth.help, stats.depth);
    registry.set(
      METRIC.spoolOldestAgeSeconds.name,
      METRIC.spoolOldestAgeSeconds.help,
      stats.oldestAgeMs === null ? 0 : stats.oldestAgeMs / 1000,
    );
  }

  for (const path of options.diskPaths ?? []) {
    const status = checkDiskSpace(path, options.minFreeBytes ?? 0);
    const labels = { path };
    registry.set(METRIC.diskFreeBytes.name, METRIC.diskFreeBytes.help, status.freeBytes, labels);
    registry.set(METRIC.diskTotalBytes.name, METRIC.diskTotalBytes.help, status.totalBytes, labels);
    const ratio = status.totalBytes > 0 ? status.freeBytes / status.totalBytes : 1;
    registry.set(METRIC.diskFreeRatio.name, METRIC.diskFreeRatio.help, ratio, labels);
    registry.set(METRIC.diskOk.name, METRIC.diskOk.help, status.ok ? 1 : 0, labels);
  }

  for (const path of options.certificatePaths ?? []) {
    const expiry = certificateExpiry(path, now);
    if (expiry === undefined) {
      continue;
    }
    const labels = { path };
    registry.set(
      METRIC.certificateExpirySeconds.name,
      METRIC.certificateExpirySeconds.help,
      Math.floor(expiry.notAfter / 1000),
      labels,
    );
    registry.set(
      METRIC.certificateExpiryDays.name,
      METRIC.certificateExpiryDays.help,
      Math.floor(expiry.secondsRemaining / DAY_SECONDS),
      labels,
    );
  }

  if (options.postfixQueue !== false) {
    const depth = readPostfixQueueDepth(options.postfixQueue ?? {});
    if (depth !== undefined) {
      registry.set(METRIC.smtpQueueDepth.name, METRIC.smtpQueueDepth.help, depth);
    }
  }
}

/** Refresh the quarantine gauges from the metadata store. */
export function collectQuarantineMetrics(registry: MetricsRegistry, db: SqliteDatabase): void {
  const counts = new Map<string, number>();
  for (const entry of listQuarantineEntries(db)) {
    counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  }
  for (const [status, count] of counts) {
    registry.set(METRIC.quarantineEntries.name, METRIC.quarantineEntries.help, count, { status });
  }
}
