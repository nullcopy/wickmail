import type { SqliteDatabase } from "../db/database.js";
import type { MutableMailStore } from "../mailstore/adapter.js";
import { QuarantineDeletion, type DeleteOptions, type DeletionOutcome } from "./deletion.js";
import { QuarantineRecovery, type RecoverOptions, type RecoveryOutcome } from "./recovery.js";
import { QuarantineReconciler, type ReconciliationReport } from "./reconciliation.js";
import { QuarantineRetention, type RetentionReport } from "./retention.js";
import type { FaultInjector, QuarantineRetentionPolicy } from "./types.js";
import { defaultQuarantineRetentionPolicy } from "./types.js";

/** Options for {@link QuarantineService}. */
export interface QuarantineServiceOptions {
  db: SqliteDatabase;
  store: MutableMailStore;
  /** The current time source. Defaults to `Date.now`. */
  now?: () => number;
  /** Retention windows and quotas. Defaults to the standard policy. */
  policy?: QuarantineRetentionPolicy;
  /** A deterministic crash hook. Defaults to no faults. */
  faults?: FaultInjector;
  /** The default interval for periodic reconciliation and retention. */
  maintenanceIntervalMs?: number;
  /** Observes every reconciliation pass, for monitoring. */
  onReconciliation?: (report: ReconciliationReport) => void;
  /** Observes every retention pass, for monitoring. */
  onRetention?: (report: RetentionReport) => void;
}

/** The result of one maintenance tick. */
export interface MaintenanceReport {
  reconciliation: ReconciliationReport;
  retention: RetentionReport;
}

/** The default interval between periodic maintenance passes: one hour. */
export const DEFAULT_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The quarantine lifecycle facade.
 *
 * It reconciles the metadata against the mail store before every destructive
 * operation, so recovery and deletion always start from a repaired state. The
 * same pass runs at startup and periodically through {@link start}.
 */
export class QuarantineService {
  readonly reconciler: QuarantineReconciler;
  readonly recovery: QuarantineRecovery;
  readonly deletion: QuarantineDeletion;
  readonly retention: QuarantineRetention;
  readonly policy: QuarantineRetentionPolicy;

  private readonly db: SqliteDatabase;
  private readonly store: MutableMailStore;
  private readonly now: () => number;
  private readonly maintenanceIntervalMs: number;
  private readonly onReconciliation: ((report: ReconciliationReport) => void) | undefined;
  private readonly onRetention: ((report: RetentionReport) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: QuarantineServiceOptions) {
    this.db = options.db;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.policy = options.policy ?? defaultQuarantineRetentionPolicy();
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    this.onReconciliation = options.onReconciliation;
    this.onRetention = options.onRetention;

    this.reconciler = new QuarantineReconciler({
      db: options.db,
      store: options.store,
      policy: this.policy,
      now: this.now,
    });
    this.recovery = new QuarantineRecovery({
      db: options.db,
      store: options.store,
      now: this.now,
      ...(options.faults !== undefined ? { faults: options.faults } : {}),
    });
    this.deletion = new QuarantineDeletion({
      db: options.db,
      store: options.store,
      now: this.now,
      ...(options.faults !== undefined ? { faults: options.faults } : {}),
    });
    this.retention = new QuarantineRetention({
      db: options.db,
      store: options.store,
      policy: this.policy,
      now: this.now,
      ...(options.faults !== undefined ? { faults: options.faults } : {}),
    });
  }

  /** Reconcile the metadata with the mail store. */
  async reconcile(): Promise<ReconciliationReport> {
    const report = await this.reconciler.runOnce();
    this.onReconciliation?.(report);
    return report;
  }

  /** Recover a quarantined message, repairing state first. */
  async recover(messageId: string, options: RecoverOptions = {}): Promise<RecoveryOutcome> {
    await this.reconcile();
    return this.recovery.recover(messageId, options);
  }

  /** Delete a quarantined message, repairing state first. */
  async delete(messageId: string, options: DeleteOptions): Promise<DeletionOutcome> {
    await this.reconcile();
    return this.deletion.delete(messageId, options);
  }

  /** Run retention, repairing state first. */
  async runRetention(): Promise<RetentionReport> {
    await this.reconcile();
    return this.runRetentionOnly();
  }

  /** Run retention without a preceding reconciliation pass. */
  private async runRetentionOnly(): Promise<RetentionReport> {
    const report = await this.retention.runOnce();
    this.onRetention?.(report);
    return report;
  }

  /** One maintenance tick: reconcile, then run retention. */
  async tick(): Promise<MaintenanceReport> {
    const reconciliation = await this.reconcile();
    const retention = await this.runRetentionOnly();
    return { reconciliation, retention };
  }

  /**
   * Reconcile immediately, then reconcile and run retention on an interval.
   * The timer is unref'd so it never keeps the process alive on its own.
   */
  start(intervalMs: number = this.maintenanceIntervalMs): void {
    if (this.timer !== undefined) {
      return;
    }
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Stop periodic maintenance. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
