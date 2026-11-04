import type { SqliteDatabase } from "../db/database.js";
import type { MutableMailStore } from "../mailstore/adapter.js";
import { recordQuarantineFromStore } from "./metadata.js";
import {
  getQuarantineEntry,
  listQuarantineEntries,
  setQuarantineLocator,
  updateQuarantineStatus,
} from "./repository.js";
import type { QuarantineRetentionPolicy } from "./types.js";
import { INBOX_MAILBOX, QUARANTINE_MAILBOXES } from "./types.js";
import { findQuarantineCopy } from "./store.js";

/** What a reconciliation pass changed. */
export interface ReconciliationReport {
  /** Metadata rows examined. */
  scanned: number;
  /** Messages whose metadata was marked `recovered`. */
  recovered: number;
  /** Messages returned to `quarantined`. */
  requarantined: number;
  /** Messages whose metadata was marked `deleted`. */
  deleted: number;
  /** Quarantine messages that had no metadata and were rebuilt from the store. */
  rebuilt: number;
  /** Cached locators refreshed. */
  relinked: number;
}

/** Options for {@link QuarantineReconciler}. */
export interface QuarantineReconcilerOptions {
  db: SqliteDatabase;
  store: MutableMailStore;
  /** The retention policy used to derive expiry for rebuilt metadata. */
  policy: QuarantineRetentionPolicy;
  /** The current time source. Defaults to `Date.now`. */
  now?: () => number;
  /** The quarantine mailboxes scanned for untracked messages. */
  quarantineMailboxes?: readonly string[];
  /** The inbox mailbox that is authoritative for recovered messages. */
  inboxMailbox?: string;
}

function emptyReport(): ReconciliationReport {
  return { scanned: 0, recovered: 0, requarantined: 0, deleted: 0, rebuilt: 0, relinked: 0 };
}

/**
 * Reconcile the quarantine metadata with the mail store, which is
 * authoritative for membership.
 *
 * The pass repairs both directions: metadata is marked `deleted` or
 * `recovered` to match the store, leftover quarantine copies are removed when
 * the inbox copy exists, and quarantine messages with no metadata are rebuilt
 * from their trusted headers. It is idempotent, so it is safe to run at
 * startup, periodically, and before destructive operations.
 */
export class QuarantineReconciler {
  private readonly db: SqliteDatabase;
  private readonly store: MutableMailStore;
  private readonly policy: QuarantineRetentionPolicy;
  private readonly now: () => number;
  private readonly quarantineMailboxes: readonly string[];
  private readonly inboxMailbox: string;

  constructor(options: QuarantineReconcilerOptions) {
    this.db = options.db;
    this.store = options.store;
    this.policy = options.policy;
    this.now = options.now ?? Date.now;
    this.quarantineMailboxes = options.quarantineMailboxes ?? QUARANTINE_MAILBOXES;
    this.inboxMailbox = options.inboxMailbox ?? INBOX_MAILBOX;
  }

  /** Run one reconciliation pass. */
  async runOnce(): Promise<ReconciliationReport> {
    const report = emptyReport();
    const now = this.now();

    for (const entry of listQuarantineEntries(this.db)) {
      report.scanned += 1;
      const quarantineCopy = await findQuarantineCopy(
        this.store,
        entry.messageId,
        this.quarantineMailboxes,
      );
      const inboxCopy = await this.store.getMessageIn(this.inboxMailbox, entry.messageId);

      if (quarantineCopy !== undefined && entry.status !== "recovered") {
        setQuarantineLocator(this.db, entry.messageId, quarantineCopy.locator, now);
        report.relinked += 1;
      }

      switch (entry.status) {
        case "quarantined": {
          if (quarantineCopy !== undefined && inboxCopy !== undefined) {
            // Keep the inbox copy, remove the quarantine copy.
            await this.store.deleteMessage(quarantineCopy.mailbox, entry.messageId);
            updateQuarantineStatus(this.db, entry.messageId, "recovered", { now });
            report.recovered += 1;
          } else if (quarantineCopy === undefined && inboxCopy !== undefined) {
            updateQuarantineStatus(this.db, entry.messageId, "recovered", { now });
            report.recovered += 1;
          } else if (quarantineCopy === undefined && inboxCopy === undefined) {
            updateQuarantineStatus(this.db, entry.messageId, "deleted", { now });
            report.deleted += 1;
          }
          break;
        }
        case "recovering": {
          if (quarantineCopy !== undefined && inboxCopy !== undefined) {
            await this.store.deleteMessage(quarantineCopy.mailbox, entry.messageId);
            updateQuarantineStatus(this.db, entry.messageId, "recovered", { now });
            report.recovered += 1;
          } else if (quarantineCopy === undefined && inboxCopy !== undefined) {
            updateQuarantineStatus(this.db, entry.messageId, "recovered", { now });
            report.recovered += 1;
          } else if (quarantineCopy === undefined && inboxCopy === undefined) {
            updateQuarantineStatus(this.db, entry.messageId, "deleted", { now });
            report.deleted += 1;
          } else {
            // The inbox copy never landed; return the message to quarantine.
            updateQuarantineStatus(this.db, entry.messageId, "quarantined", { now });
            report.requarantined += 1;
          }
          break;
        }
        case "deleting": {
          if (quarantineCopy !== undefined) {
            await this.store.deleteMessage(quarantineCopy.mailbox, entry.messageId);
          }
          updateQuarantineStatus(this.db, entry.messageId, "deleted", { now });
          report.deleted += 1;
          break;
        }
        case "recovered": {
          if (quarantineCopy !== undefined) {
            await this.store.deleteMessage(quarantineCopy.mailbox, entry.messageId);
          }
          break;
        }
        case "deleted": {
          if (quarantineCopy !== undefined) {
            await this.store.deleteMessage(quarantineCopy.mailbox, entry.messageId);
          }
          break;
        }
      }
    }

    // Rebuild metadata for quarantine messages the database does not track.
    for (const mailbox of this.quarantineMailboxes) {
      for (const message of await this.store.listMessages(mailbox)) {
        if (getQuarantineEntry(this.db, message.messageId) === undefined) {
          recordQuarantineFromStore(this.db, message, this.policy);
          report.rebuilt += 1;
        }
      }
    }

    return report;
  }
}
