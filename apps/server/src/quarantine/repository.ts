import type { MessageLocator, QuarantineStatus, QuarantinedMessage } from "wickmail-core";
import { quarantineStatusSchema } from "wickmail-core";
import type { SqliteDatabase } from "../db/database.js";
import { toIsoTimestamp } from "../time.js";
import type { QuarantineEntry } from "./types.js";
import { QuarantineNotFoundError } from "./types.js";

/** Input for recording quarantine metadata. */
export interface RecordQuarantinedMessageInput {
  messageId: string;
  aliasIds?: readonly string[];
  sender?: string | null;
  subject?: string | null;
  receivedAt: number;
  quarantineExpiresAt?: number | null;
  status?: QuarantineStatus;
  mailbox?: string | null;
  locator?: MessageLocator | null;
  operationKey?: string | null;
  /** When the metadata row is written, in epoch milliseconds. Defaults to now. */
  recordedAt?: number;
}

/** Fields a status transition may change alongside the status. */
export interface QuarantineStatusChanges {
  /** The operation note: a recovery idempotency key or a deletion reason. */
  operationKey?: string | null;
  /** The transition time in epoch milliseconds. Defaults to `Date.now`. */
  now?: number;
}

interface QuarantineRow {
  messageId: string;
  sender: string | null;
  subject: string | null;
  receivedAt: number;
  quarantineExpiresAt: number | null;
  status: QuarantineStatus;
  mailbox: string | null;
  uidValidity: number | null;
  uid: number | null;
  operationKey: string | null;
  createdAt: number;
  updatedAt: number;
}

const SELECT_ENTRY = `
  SELECT
    message_id AS messageId,
    sender AS sender,
    subject AS subject,
    received_at AS receivedAt,
    quarantine_expires_at AS quarantineExpiresAt,
    status AS status,
    mailbox AS mailbox,
    uid_validity AS uidValidity,
    uid AS uid,
    idempotency_key AS operationKey,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM quarantine_messages
`;

function aliasIdsFor(db: SqliteDatabase, messageId: string): string[] {
  return (
    db
      .prepare(
        `SELECT alias_id AS aliasId FROM quarantine_message_aliases
         WHERE message_id = ? ORDER BY alias_id ASC`,
      )
      .all(messageId) as Array<{ aliasId: string }>
  ).map((link) => link.aliasId);
}

function mapRow(db: SqliteDatabase, row: QuarantineRow): QuarantineEntry {
  const locator: MessageLocator | null =
    row.mailbox !== null && row.uidValidity !== null && row.uid !== null
      ? { mailbox: row.mailbox, uidValidity: row.uidValidity, uid: row.uid }
      : null;
  return {
    messageId: row.messageId,
    aliasIds: aliasIdsFor(db, row.messageId),
    sender: row.sender,
    subject: row.subject,
    receivedAt: row.receivedAt,
    quarantineExpiresAt: row.quarantineExpiresAt,
    status: row.status,
    mailbox: row.mailbox,
    locator,
    operationKey: row.operationKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Link aliases to a quarantined message, ignoring duplicates. */
export function linkQuarantineAliases(
  db: SqliteDatabase,
  messageId: string,
  aliasIds: readonly string[],
): void {
  const link = db.prepare(
    `INSERT OR IGNORE INTO quarantine_message_aliases (message_id, alias_id) VALUES (?, ?)`,
  );
  for (const aliasId of aliasIds) {
    link.run(messageId, aliasId);
  }
}

/**
 * Record quarantine metadata. When the message is already tracked, the
 * descriptive fields are refreshed but the status and its operation note are
 * left to the state machine.
 */
export function recordQuarantinedMessage(
  db: SqliteDatabase,
  input: RecordQuarantinedMessageInput,
): QuarantineEntry {
  const status = quarantineStatusSchema.parse(input.status ?? "quarantined");
  const now = input.recordedAt ?? Date.now();
  const record = db.transaction(() => {
    const existing = getQuarantineEntry(db, input.messageId);
    if (existing === undefined) {
      db.prepare(
        `INSERT INTO quarantine_messages (
           message_id, sender, subject, received_at, quarantine_expires_at, status,
           mailbox, uid_validity, uid, idempotency_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.messageId,
        input.sender ?? null,
        input.subject ?? null,
        input.receivedAt,
        input.quarantineExpiresAt ?? null,
        status,
        input.mailbox ?? null,
        input.locator?.uidValidity ?? null,
        input.locator?.uid ?? null,
        input.operationKey ?? null,
        now,
        now,
      );
    } else {
      db.prepare(
        `UPDATE quarantine_messages SET
           sender = ?, subject = ?, received_at = ?, quarantine_expires_at = ?,
           mailbox = ?, uid_validity = ?, uid = ?, updated_at = ?
         WHERE message_id = ?`,
      ).run(
        input.sender ?? existing.sender,
        input.subject ?? existing.subject,
        input.receivedAt,
        input.quarantineExpiresAt === undefined
          ? existing.quarantineExpiresAt
          : input.quarantineExpiresAt,
        input.mailbox === undefined ? existing.mailbox : input.mailbox,
        input.locator === undefined
          ? (existing.locator?.uidValidity ?? null)
          : (input.locator?.uidValidity ?? null),
        input.locator === undefined
          ? (existing.locator?.uid ?? null)
          : (input.locator?.uid ?? null),
        now,
        input.messageId,
      );
    }
    linkQuarantineAliases(db, input.messageId, input.aliasIds ?? []);
  });
  record();
  return requireQuarantineEntry(db, input.messageId);
}

/** Fetch quarantine metadata by message ID, or undefined. */
export function getQuarantineEntry(
  db: SqliteDatabase,
  messageId: string,
): QuarantineEntry | undefined {
  const row = db.prepare(`${SELECT_ENTRY} WHERE message_id = ?`).get(messageId) as
    QuarantineRow | undefined;
  return row === undefined ? undefined : mapRow(db, row);
}

/** Fetch quarantine metadata by message ID, throwing when it does not exist. */
export function requireQuarantineEntry(db: SqliteDatabase, messageId: string): QuarantineEntry {
  const entry = getQuarantineEntry(db, messageId);
  if (entry === undefined) {
    throw new QuarantineNotFoundError(messageId);
  }
  return entry;
}

/** Options for listing quarantine metadata. */
export interface ListQuarantineOptions {
  status?: QuarantineStatus;
}

/** List quarantine metadata, oldest first, with a stable secondary sort. */
export function listQuarantineEntries(
  db: SqliteDatabase,
  options: ListQuarantineOptions = {},
): QuarantineEntry[] {
  const where = options.status === undefined ? "" : " WHERE status = ?";
  const rows = db
    .prepare(
      `${SELECT_ENTRY}${where}
       ORDER BY received_at ASC, message_id ASC`,
    )
    .all(...(options.status === undefined ? [] : [options.status])) as QuarantineRow[];
  return rows.map((row) => mapRow(db, row));
}

/** Move a message to a new status, recording the operation note and time. */
export function updateQuarantineStatus(
  db: SqliteDatabase,
  messageId: string,
  status: QuarantineStatus,
  changes: QuarantineStatusChanges = {},
): QuarantineEntry {
  const parsed = quarantineStatusSchema.parse(status);
  const now = changes.now ?? Date.now();
  const result = db
    .prepare(
      `UPDATE quarantine_messages
       SET status = ?, idempotency_key = COALESCE(?, idempotency_key), updated_at = ?
       WHERE message_id = ?`,
    )
    .run(parsed, changes.operationKey ?? null, now, messageId);
  if (result.changes === 0) {
    throw new QuarantineNotFoundError(messageId);
  }
  return requireQuarantineEntry(db, messageId);
}

/** Cache a message's locator, or clear it when null. */
export function setQuarantineLocator(
  db: SqliteDatabase,
  messageId: string,
  locator: MessageLocator | null,
  now: number = Date.now(),
): void {
  db.prepare(
    `UPDATE quarantine_messages
     SET mailbox = ?, uid_validity = ?, uid = ?, updated_at = ?
     WHERE message_id = ?`,
  ).run(
    locator?.mailbox ?? null,
    locator?.uidValidity ?? null,
    locator?.uid ?? null,
    now,
    messageId,
  );
}

/** Set the retention deadline for a message. */
export function setQuarantineExpiry(
  db: SqliteDatabase,
  messageId: string,
  quarantineExpiresAt: number | null,
  now: number = Date.now(),
): void {
  db.prepare(
    `UPDATE quarantine_messages SET quarantine_expires_at = ?, updated_at = ? WHERE message_id = ?`,
  ).run(quarantineExpiresAt, now, messageId);
}

/** Delete quarantine metadata and its alias links. */
export function deleteQuarantineEntry(db: SqliteDatabase, messageId: string): void {
  db.prepare(`DELETE FROM quarantine_messages WHERE message_id = ?`).run(messageId);
}

/**
 * Delete metadata for messages that have been `deleted` for at least the grace
 * period. Returns the number purged.
 */
export function purgeDeletedMetadata(
  db: SqliteDatabase,
  options: { now: number; graceMs: number },
): number {
  const cutoff = options.now - options.graceMs;
  const result = db
    .prepare(`DELETE FROM quarantine_messages WHERE status = 'deleted' AND updated_at <= ?`)
    .run(cutoff);
  return result.changes;
}

/** Map quarantine metadata to the shared management-API shape. */
export function toQuarantinedMessage(entry: QuarantineEntry): QuarantinedMessage {
  return {
    messageId: entry.messageId,
    aliasIds: entry.aliasIds,
    sender: entry.sender,
    subject: entry.subject,
    receivedAt: toIsoTimestamp(entry.receivedAt) ?? "",
    quarantineExpiresAt: toIsoTimestamp(entry.quarantineExpiresAt),
    status: entry.status,
    locator: entry.locator,
  };
}
