import type { SqliteDatabase } from "../db/database.js";
import type { MutableMailStore } from "../mailstore/adapter.js";
import { getQuarantineEntry, updateQuarantineStatus } from "./repository.js";
import type { FaultInjector } from "./types.js";
import { noFaults } from "./types.js";
import { findQuarantineCopy } from "./store.js";

/** The outcome of a deletion attempt. */
export type DeletionOutcome =
  | { status: "deleted"; messageId: string }
  | { status: "already_deleted"; messageId: string }
  | { status: "blocked"; messageId: string; reason: string }
  | { status: "not_found"; messageId: string };

/** Options for a single deletion. */
export interface DeleteOptions {
  /** Why the message is being deleted. Recorded with the `deleting` mark. */
  reason: string;
}

/** Options for {@link QuarantineDeletion}. */
export interface QuarantineDeletionOptions {
  db: SqliteDatabase;
  store: MutableMailStore;
  /** The current time source. Defaults to `Date.now`. */
  now?: () => number;
  /** A deterministic crash hook. Defaults to no faults. */
  faults?: FaultInjector;
}

/**
 * The crash-safe deletion state machine.
 *
 * The order is: mark `deleting` with a reason, delete the body, then mark
 * `deleted`. A crash between any two steps is repaired by reconciliation: a
 * message left `deleting` is finished, and a body that is already gone is
 * recorded as `deleted`.
 */
export class QuarantineDeletion {
  private readonly db: SqliteDatabase;
  private readonly store: MutableMailStore;
  private readonly now: () => number;
  private readonly faults: FaultInjector;

  constructor(options: QuarantineDeletionOptions) {
    this.db = options.db;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.faults = options.faults ?? noFaults;
  }

  /** Delete one quarantined message's body and mark its metadata deleted. */
  async delete(messageId: string, options: DeleteOptions): Promise<DeletionOutcome> {
    const entry = getQuarantineEntry(this.db, messageId);
    if (entry === undefined) {
      return { status: "not_found", messageId };
    }
    if (entry.status === "deleted") {
      return { status: "already_deleted", messageId };
    }
    if (entry.status === "recovering") {
      return { status: "blocked", messageId, reason: "recovery is in progress" };
    }
    if (entry.status === "recovered") {
      // The body already moved to the inbox; only the metadata remains.
      updateQuarantineStatus(this.db, messageId, "deleted", { now: this.now() });
      return { status: "deleted", messageId };
    }

    // 1. Mark deleting with a reason. Recovery refuses a message in this state.
    updateQuarantineStatus(this.db, messageId, "deleting", {
      operationKey: options.reason,
      now: this.now(),
    });
    await this.faults("deletion.before_body_delete");

    // 2. Delete the body from the quarantine folder.
    const quarantineCopy = await findQuarantineCopy(this.store, messageId);
    if (quarantineCopy !== undefined) {
      await this.store.deleteMessage(quarantineCopy.mailbox, messageId);
    }
    await this.faults("deletion.after_body_delete");

    // 3. Mark the metadata deleted.
    updateQuarantineStatus(this.db, messageId, "deleted", { now: this.now() });
    return { status: "deleted", messageId };
  }
}
