import { statfsSync } from "node:fs";

/** Free-space status for a filesystem. */
export interface DiskSpaceStatus {
  path: string;
  /** Bytes available to an unprivileged writer. */
  freeBytes: number;
  /** Total filesystem size in bytes. */
  totalBytes: number;
  /** Whether free space is at or above the floor. */
  ok: boolean;
  /** Set when the filesystem could not be inspected. */
  error?: string;
}

/**
 * Inspect the free space on the filesystem holding `path`. A filesystem that
 * cannot be inspected is reported as OK, because a pre-flight failure must not
 * block delivery; the write path still reports `ENOSPC`.
 */
export function checkDiskSpace(path: string, minFreeBytes: number): DiskSpaceStatus {
  try {
    const stats = statfsSync(path);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    return { path, freeBytes, totalBytes, ok: freeBytes >= minFreeBytes };
  } catch (error) {
    return {
      path,
      freeBytes: Number.POSITIVE_INFINITY,
      totalBytes: Number.POSITIVE_INFINITY,
      ok: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** An operational alert. Alerts never contain message bodies. */
export interface Alert {
  /** A stable kind such as `disk_full` or `spool_unavailable`. */
  kind: string;
  /** A human-readable description. */
  message: string;
  /** When the alert fired, in epoch milliseconds. */
  at: number;
  /** Non-content context such as a path or spool depth. */
  context?: Record<string, unknown>;
}

/** A sink for operational alerts. */
export interface AlertSink {
  alert(alert: Alert): void;
}

/** An alert sink that collects alerts in memory, for tests and logging. */
export class MemoryAlertSink implements AlertSink {
  readonly alerts: Alert[] = [];

  alert(alert: Alert): void {
    this.alerts.push(alert);
  }

  /** Alerts of a kind, in order. */
  ofKind(kind: string): Alert[] {
    return this.alerts.filter((alert) => alert.kind === kind);
  }
}

/** An alert sink that discards every alert. */
export const noopAlertSink: AlertSink = { alert: () => {} };

/** Whether an error is the filesystem's out-of-space signal. */
export function isDiskFullError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOSPC"
  );
}

/** Emit a disk-full alert. */
export function alertDiskFull(
  sink: AlertSink,
  at: number,
  context?: Record<string, unknown>,
): void {
  sink.alert({
    kind: "disk_full",
    message: "filesystem is full; accepted mail is deferred, not dropped",
    at,
    ...(context !== undefined ? { context } : {}),
  });
}
