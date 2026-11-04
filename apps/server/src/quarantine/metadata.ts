import { wickmailHeader } from "wickmail-core";
import { getHeader, getHeaderValues } from "../mail/headers.js";
import type { StoredMessage } from "../mailstore/adapter.js";
import type { SqliteDatabase } from "../db/database.js";
import { recordQuarantinedMessage, type RecordQuarantinedMessageInput } from "./repository.js";
import type { QuarantineRetentionPolicy } from "./types.js";
import { DAY_MS, retentionClassForMailbox } from "./types.js";

/** Quarantine metadata parsed from a stored message's trusted headers. */
export interface ParsedQuarantineMetadata {
  sender: string | null;
  subject: string | null;
  aliasIds: string[];
  receivedAt: number;
}

/**
 * Parse the quarantine metadata carried by a stored message. Identity and
 * alias IDs come from the trusted `X-Wickmail-*` headers; sender and subject
 * are display fields.
 */
export function parseQuarantineMetadata(message: StoredMessage): ParsedQuarantineMetadata {
  return {
    sender: getHeader(message.raw, "From") ?? null,
    subject: getHeader(message.raw, "Subject") ?? null,
    aliasIds: getHeaderValues(message.raw, wickmailHeader.aliasId),
    receivedAt: message.receivedAt,
  };
}

/** The retention deadline for a message, given its mailbox and the policy. */
export function retentionExpiry(
  receivedAt: number,
  mailbox: string | null,
  policy: QuarantineRetentionPolicy,
): number {
  const days =
    retentionClassForMailbox(mailbox) === "spam"
      ? policy.spamRetentionDays
      : policy.leaseRetentionDays;
  return receivedAt + days * DAY_MS;
}

/**
 * Record quarantine metadata for a stored message, deriving the retention
 * deadline from the mailbox's retention class.
 */
export function recordQuarantineFromStore(
  db: SqliteDatabase,
  message: StoredMessage,
  policy: QuarantineRetentionPolicy,
): void {
  const parsed = parseQuarantineMetadata(message);
  const input: RecordQuarantinedMessageInput = {
    messageId: message.messageId,
    aliasIds: parsed.aliasIds,
    sender: parsed.sender,
    subject: parsed.subject,
    receivedAt: parsed.receivedAt,
    quarantineExpiresAt: retentionExpiry(parsed.receivedAt, message.mailbox, policy),
    mailbox: message.mailbox,
    locator: message.locator,
  };
  recordQuarantinedMessage(db, input);
}
