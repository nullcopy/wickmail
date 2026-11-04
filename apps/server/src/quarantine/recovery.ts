import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../db/database.js";
import type { MutableMailStore } from "../mailstore/adapter.js";
import { getQuarantineEntry, updateQuarantineStatus } from "./repository.js";
import type { FaultInjector } from "./types.js";
import { INBOX_MAILBOX, noFaults } from "./types.js";
import { findQuarantineCopy } from "./store.js";

/** The outcome of a recovery attempt. */
export type RecoveryOutcome =
  | { status: "recovered"; messageId: string }
  | { status: "already_recovered"; messageId: string }
  | { status: "blocked"; messageId: string; reason: string }
  | { status: "incomplete"; messageId: string; reason: string }
  | { status: "not_found"; messageId: string };

/** Options for a single recovery. */
export interface RecoverOptions {
  /** A stable key that makes the recovery step retry-safe. Defaults to a UUID. */
  idempotencyKey?: string;
}

/** Options for {@link QuarantineRecovery}. */
export interface QuarantineRecoveryOptions {
  db: SqliteDatabase;
  store: MutableMailStore;
  /** The current time source. Defaults to `Date.now`. */
  now?: () => number;
  /** A deterministic crash hook. Defaults to no faults. */
  faults?: FaultInjector;
  /** The mailbox a recovered message is copied into. Defaults to `Inbox`. */
  inboxMailbox?: string;
}

/**
 * The crash-safe recovery state machine.
 *
 * The order is: record `recovering` with an idempotency key, copy the message
 * to the inbox, verify the copy by message ID, delete the quarantine copy, and
 * mark the metadata `recovered`. A crash at any step leaves a state that
 * reconciliation can repair, and the inbox copy is verified by identity before
 * the quarantine copy is removed, so a recovered message is never duplicated.
 */
export class QuarantineRecovery {
  private readonly db: SqliteDatabase;
  private readonly store: MutableMailStore;
  private readonly now: () => number;
  private readonly faults: FaultInjector;
  private readonly inboxMailbox: string;

  constructor(options: QuarantineRecoveryOptions) {
    this.db = options.db;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.faults = options.faults ?? noFaults;
    this.inboxMailbox = options.inboxMailbox ?? INBOX_MAILBOX;
  }

  /** Recover one quarantined message into the inbox. */
  async recover(messageId: string, options: RecoverOptions = {}): Promise<RecoveryOutcome> {
    const entry = getQuarantineEntry(this.db, messageId);
    if (entry === undefined) {
      return { status: "not_found", messageId };
    }
    if (entry.status === "recovered") {
      return { status: "already_recovered", messageId };
    }
    if (entry.status === "deleting" || entry.status === "deleted") {
      return { status: "blocked", messageId, reason: `message is ${entry.status}` };
    }

    // 1. Record intent with an idempotency key.
    const idempotencyKey = options.idempotencyKey ?? randomUUID();
    updateQuarantineStatus(this.db, messageId, "recovering", {
      operationKey: idempotencyKey,
      now: this.now(),
    });
    await this.faults("recovery.before_copy");

    // 2. Copy to the inbox without deleting the quarantine copy.
    if ((await this.store.getMessageIn(this.inboxMailbox, messageId)) === undefined) {
      await this.store.copyMessage(messageId, this.inboxMailbox);
    }
    await this.faults("recovery.after_copy");

    // 3. Verify the inbox copy by message ID.
    const inboxCopy = await this.store.getMessageIn(this.inboxMailbox, messageId);
    if (inboxCopy === undefined || inboxCopy.messageId !== messageId) {
      return { status: "incomplete", messageId, reason: "inbox copy could not be verified" };
    }

    // 4. Delete the quarantine copy now that the inbox copy is confirmed.
    const quarantineCopy = await findQuarantineCopy(this.store, messageId);
    if (quarantineCopy !== undefined) {
      await this.store.deleteMessage(quarantineCopy.mailbox, messageId);
    }
    await this.faults("recovery.after_delete");

    // 5. Mark the metadata recovered.
    updateQuarantineStatus(this.db, messageId, "recovered", { now: this.now() });
    return { status: "recovered", messageId };
  }
}
