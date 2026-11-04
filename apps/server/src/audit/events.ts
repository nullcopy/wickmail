import { randomUUID } from "node:crypto";
import type { AliasEventType } from "wickmail-core";
import { aliasEventTypeSchema } from "wickmail-core";
import type { SqliteDatabase } from "../db/database.js";

/**
 * Audit records are retained longer than delivery metadata, which includes
 * quarantine and provenance rows. Subjects and addresses in delivery metadata
 * are purged with their retention window; audit records are not.
 */
export const AUDIT_RETENTION_DAYS = 365;

/** Retention for delivery metadata, including quarantine and provenance. */
export const DELIVERY_METADATA_RETENTION_DAYS = 30;

/**
 * Detail keys that would smuggle a message body into an audit record. Audit
 * records describe lifecycle transitions and never carry message content.
 */
const FORBIDDEN_DETAIL_KEYS: ReadonlySet<string> = new Set([
  "body",
  "bodyText",
  "html",
  "messageBody",
  "raw",
  "text",
]);

/** Thrown when an audit detail carries a message body. */
export class AuditDetailError extends Error {
  override name = "AuditDetailError";

  constructor(readonly key: string) {
    super(`audit event detail must not contain message content: ${key}`);
  }
}

/** Input for recording a lifecycle event. */
export interface RecordAuditEventInput {
  aliasId: string;
  type: AliasEventType;
  /** When the transition occurred, in epoch milliseconds. */
  occurredAt: number;
  /** Non-content detail such as a reason or previous expiry. */
  detail?: Record<string, unknown> | null;
}

/** A stored lifecycle event. */
export interface AuditEventRecord {
  id: string;
  aliasId: string;
  type: AliasEventType;
  occurredAt: number;
  detail: Record<string, unknown> | null;
}

/**
 * Record a lifecycle event. The type is validated against the shared event
 * union, and the detail object is rejected when it carries message content.
 */
export function recordAuditEvent(
  db: SqliteDatabase,
  input: RecordAuditEventInput,
): AuditEventRecord {
  const type = aliasEventTypeSchema.parse(input.type);
  const detail = input.detail ?? null;

  if (detail !== null) {
    for (const key of Object.keys(detail)) {
      if (FORBIDDEN_DETAIL_KEYS.has(key)) {
        throw new AuditDetailError(key);
      }
    }
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO audit_events (id, alias_id, type, occurred_at, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.aliasId,
    type,
    input.occurredAt,
    detail === null ? null : JSON.stringify(detail),
    Date.now(),
  );

  return { id, aliasId: input.aliasId, type, occurredAt: input.occurredAt, detail };
}

/** List an alias's lifecycle events in occurrence order. */
export function listAuditEvents(db: SqliteDatabase, aliasId: string): AuditEventRecord[] {
  const rows = db
    .prepare(
      `SELECT id, alias_id AS aliasId, type, occurred_at AS occurredAt, detail
       FROM audit_events
       WHERE alias_id = ?
       ORDER BY occurred_at ASC, id ASC`,
    )
    .all(aliasId) as Array<{
    id: string;
    aliasId: string;
    type: AliasEventType;
    occurredAt: number;
    detail: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    aliasId: row.aliasId,
    type: row.type,
    occurredAt: row.occurredAt,
    detail: row.detail === null ? null : (JSON.parse(row.detail) as Record<string, unknown>),
  }));
}
