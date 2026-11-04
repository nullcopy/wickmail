import type { MessageLocator, QuarantineStatus } from "wickmail-core";

export type { QuarantineStatus };

/** The inbox mailbox that recovery copies a quarantined message into. */
export const INBOX_MAILBOX = "Inbox";

/** One day in milliseconds. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The lease-quarantine mailbox. It is isolated from the user IMAP namespace
 * and is only reachable through the internal mail-store adapter.
 */
export const QUARANTINE_MAILBOX = "Aliases/Expired";

/** The spam mailbox. Spam retention is configured separately from lease quarantine. */
export const SPAM_MAILBOX = "Spam";

/** Every mailbox that holds quarantined bodies, searched by identity. */
export const QUARANTINE_MAILBOXES: readonly string[] = [QUARANTINE_MAILBOX, SPAM_MAILBOX];

/** Which retention window governs a quarantined message. */
export type RetentionClass = "lease" | "spam";

/**
 * Quarantine metadata, joined with its alias links and cached locator.
 *
 * `operationKey` is the note for the current in-flight operation: the recovery
 * idempotency key while the status is `recovering`, and the deletion reason
 * while the status is `deleting`. It is never identity; `messageId` is.
 */
export interface QuarantineEntry {
  messageId: string;
  aliasIds: string[];
  sender: string | null;
  subject: string | null;
  /** Acceptance time in epoch milliseconds. */
  receivedAt: number;
  /** When retention may delete the message, in epoch milliseconds. */
  quarantineExpiresAt: number | null;
  status: QuarantineStatus;
  /** The mailbox from the cached locator, or null. A cache, never identity. */
  mailbox: string | null;
  /** The cached locator, or null. Never identity. */
  locator: MessageLocator | null;
  operationKey: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The retention class that governs a quarantined message. */
export function retentionClassForMailbox(mailbox: string | null): RetentionClass {
  return mailbox === SPAM_MAILBOX ? "spam" : "lease";
}

/** Retention windows and quotas for quarantine. */
export interface QuarantineRetentionPolicy {
  /** Lease-quarantine retention in days. Defaults to 30. */
  leaseRetentionDays: number;
  /** Spam retention in days. Defaults to 14. */
  spamRetentionDays: number;
  /** How long deleted metadata is kept before it is purged, in days. Defaults to 7. */
  metadataGraceDays: number;
  /** Quotas applied after expiry-based retention. */
  quota: QuarantineQuota;
}

/**
 * Quarantine quotas. When a quota is exceeded the oldest eligible messages are
 * deleted first; a message in `recovering` or `deleting` is never eligible.
 */
export interface QuarantineQuota {
  /** Maximum quarantined messages overall. */
  maxMessages?: number;
  /** Maximum total quarantined bytes overall. */
  maxBytes?: number;
  /** Maximum quarantined messages per alias. */
  maxMessagesPerAlias?: number;
}

/** The default lease-quarantine retention, in days. */
export const DEFAULT_LEASE_RETENTION_DAYS = 30;

/** The default spam retention, in days. */
export const DEFAULT_SPAM_RETENTION_DAYS = 14;

/** The default metadata grace period after deletion, in days. */
export const DEFAULT_METADATA_GRACE_DAYS = 7;

/** The default quarantine retention policy. */
export function defaultQuarantineRetentionPolicy(): QuarantineRetentionPolicy {
  return {
    leaseRetentionDays: DEFAULT_LEASE_RETENTION_DAYS,
    spamRetentionDays: DEFAULT_SPAM_RETENTION_DAYS,
    metadataGraceDays: DEFAULT_METADATA_GRACE_DAYS,
    quota: {},
  };
}

/**
 * A deterministic fault-injection point. A test injector throws at a chosen
 * point to simulate a crash between two steps of a state machine.
 */
export type QuarantineFaultPoint =
  | "recovery.before_copy"
  | "recovery.after_copy"
  | "recovery.after_delete"
  | "deletion.before_body_delete"
  | "deletion.after_body_delete";

/** A deterministic crash hook. It may inspect state before it throws. */
export type FaultInjector = (point: QuarantineFaultPoint) => void | Promise<void>;

/** A fault injector that never faults. */
export const noFaults: FaultInjector = () => {};

/** Thrown when quarantine metadata does not exist. */
export class QuarantineNotFoundError extends Error {
  override name = "QuarantineNotFoundError";

  constructor(readonly messageId: string) {
    super(`quarantine metadata not found: ${messageId}`);
  }
}
