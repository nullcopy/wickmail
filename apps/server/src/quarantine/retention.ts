import type { SqliteDatabase } from "../db/database.js";
import type { MutableMailStore } from "../mailstore/adapter.js";
import { QuarantineDeletion } from "./deletion.js";
import { listQuarantineEntries, purgeDeletedMetadata } from "./repository.js";
import type { FaultInjector, QuarantineEntry, QuarantineRetentionPolicy } from "./types.js";
import { DAY_MS, defaultQuarantineRetentionPolicy } from "./types.js";
import { findQuarantineCopy } from "./store.js";

/** What a retention pass did. */
export interface RetentionReport {
  /** Messages deleted because their retention deadline passed. */
  expired: number;
  /** Messages deleted to satisfy a quota. */
  quota: number;
  /** Metadata rows purged after the deletion grace period. */
  purged: number;
  /** Candidates skipped because recovery or deletion was in flight. */
  skipped: number;
}

/** Options for {@link QuarantineRetention}. */
export interface QuarantineRetentionOptions {
  db: SqliteDatabase;
  store: MutableMailStore;
  /** The current time source. Defaults to `Date.now`. */
  now?: () => number;
  /** Retention windows and quotas. Defaults to the standard policy. */
  policy?: QuarantineRetentionPolicy;
  /** A deterministic crash hook. Defaults to no faults. */
  faults?: FaultInjector;
}

/**
 * Quarantine retention.
 *
 * Retention deletes expired messages oldest first, then enforces quotas oldest
 * first, and finally purges deleted metadata after its grace period. A message
 * in `recovering` or `deleting` is never eligible, so retention cannot race
 * recovery or deletion.
 */
export class QuarantineRetention {
  private readonly db: SqliteDatabase;
  private readonly store: MutableMailStore;
  private readonly now: () => number;
  private readonly policy: QuarantineRetentionPolicy;
  private readonly deletion: QuarantineDeletion;

  constructor(options: QuarantineRetentionOptions) {
    this.db = options.db;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.policy = options.policy ?? defaultQuarantineRetentionPolicy();
    this.deletion = new QuarantineDeletion({
      db: options.db,
      store: options.store,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.faults !== undefined ? { faults: options.faults } : {}),
    });
  }

  /** Run one retention pass. */
  async runOnce(): Promise<RetentionReport> {
    const now = this.now();
    const report: RetentionReport = { expired: 0, quota: 0, purged: 0, skipped: 0 };

    for (const entry of this.eligible()) {
      if (entry.quarantineExpiresAt === null || entry.quarantineExpiresAt > now) {
        continue;
      }
      const outcome = await this.deletion.delete(entry.messageId, {
        reason: "retention_expired",
      });
      if (outcome.status === "deleted") {
        report.expired += 1;
      } else {
        report.skipped += 1;
      }
    }

    report.quota = await this.applyQuota();
    report.purged = purgeDeletedMetadata(this.db, {
      now,
      graceMs: this.policy.metadataGraceDays * DAY_MS,
    });
    return report;
  }

  /** Quarantined messages eligible for retention, oldest first. */
  private eligible(): QuarantineEntry[] {
    return listQuarantineEntries(this.db, { status: "quarantined" });
  }

  private async applyQuota(): Promise<number> {
    const quota = this.policy.quota;
    let removed = 0;

    if (quota.maxMessages !== undefined) {
      removed += await this.deleteOldest(this.eligible(), quota.maxMessages);
    }
    if (quota.maxBytes !== undefined) {
      removed += await this.enforceByteQuota(quota.maxBytes);
    }
    if (quota.maxMessagesPerAlias !== undefined) {
      removed += await this.enforcePerAliasQuota(quota.maxMessagesPerAlias);
    }

    return removed;
  }

  /** Delete the oldest entries until at most `maxMessages` remain. */
  private async deleteOldest(entries: QuarantineEntry[], maxMessages: number): Promise<number> {
    const over = entries.length - maxMessages;
    let removed = 0;
    for (const entry of entries.slice(0, Math.max(0, over))) {
      const outcome = await this.deletion.delete(entry.messageId, { reason: "retention_quota" });
      if (outcome.status === "deleted") {
        removed += 1;
      }
    }
    return removed;
  }

  private async enforceByteQuota(maxBytes: number): Promise<number> {
    const entries = this.eligible();
    const sizes = new Map<string, number>();
    let total = 0;
    for (const entry of entries) {
      const message = await findQuarantineCopy(this.store, entry.messageId);
      const size = message === undefined ? 0 : Buffer.byteLength(message.raw, "utf8");
      sizes.set(entry.messageId, size);
      total += size;
    }

    let removed = 0;
    for (const entry of entries) {
      if (total <= maxBytes) {
        break;
      }
      const outcome = await this.deletion.delete(entry.messageId, { reason: "retention_quota" });
      if (outcome.status === "deleted") {
        total -= sizes.get(entry.messageId) ?? 0;
        removed += 1;
      }
    }
    return removed;
  }

  private async enforcePerAliasQuota(maxMessagesPerAlias: number): Promise<number> {
    const entries = this.eligible();
    const byAlias = new Map<string, QuarantineEntry[]>();
    for (const entry of entries) {
      for (const aliasId of entry.aliasIds) {
        const list = byAlias.get(aliasId) ?? [];
        list.push(entry);
        byAlias.set(aliasId, list);
      }
    }

    const doomed = new Set<string>();
    for (const list of byAlias.values()) {
      const over = list.length - maxMessagesPerAlias;
      for (const entry of list.slice(0, Math.max(0, over))) {
        doomed.add(entry.messageId);
      }
    }

    let removed = 0;
    for (const messageId of doomed) {
      const outcome = await this.deletion.delete(messageId, { reason: "retention_quota" });
      if (outcome.status === "deleted") {
        removed += 1;
      }
    }
    return removed;
  }
}
