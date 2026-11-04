import type { SqliteDatabase } from "../db/database.js";
import { badRequest } from "./errors.js";

/** How long an idempotency record is kept: 24 hours. */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_KEY_LENGTH = 255;

/** A stored response replayed for a repeated idempotency key. */
export interface StoredResult {
  status: number;
  body: unknown;
}

/** The outcome of an idempotent operation. */
export interface IdempotentOutcome<T> {
  status: number;
  body: T;
  /** Whether the response was replayed from a previous request. */
  replayed: boolean;
}

/** Validate an `Idempotency-Key` header value. */
export function validateIdempotencyKey(key: string): void {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw badRequest("Idempotency-Key must be between 1 and 255 characters");
  }
}

/** Look up a stored response for a key and scope. */
export function getIdempotentResult(
  db: SqliteDatabase,
  key: string,
  scope: string,
): StoredResult | undefined {
  const row = db
    .prepare(
      "SELECT status AS status, response AS response FROM idempotency_keys WHERE key = ? AND scope = ?",
    )
    .get(key, scope) as { status: number; response: string } | undefined;
  if (row === undefined) {
    return undefined;
  }
  return { status: row.status, body: JSON.parse(row.response) as unknown };
}

/** Persist the response for a key and scope. */
export function storeIdempotentResult(
  db: SqliteDatabase,
  key: string,
  scope: string,
  result: StoredResult,
  now: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO idempotency_keys (key, scope, status, response, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(key, scope, result.status, JSON.stringify(result.body), now);
}

/**
 * Run a mutation idempotently. When a key is supplied, a repeated request
 * replays the stored response instead of re-running the handler. A handler that
 * throws stores nothing, so a failed attempt can be retried with the same key.
 */
export async function runIdempotent<T>(
  db: SqliteDatabase,
  input: { key: string | undefined; scope: string; now: number },
  compute: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentOutcome<T>> {
  if (input.key === undefined) {
    const result = await compute();
    return { ...result, replayed: false };
  }
  validateIdempotencyKey(input.key);

  const existing = getIdempotentResult(db, input.key, input.scope);
  if (existing !== undefined) {
    return { status: existing.status, body: existing.body as T, replayed: true };
  }

  const result = await compute();
  storeIdempotentResult(db, input.key, input.scope, result, input.now);
  return { ...result, replayed: false };
}

/** Remove idempotency records older than the retention window. */
export function purgeIdempotencyKeys(
  db: SqliteDatabase,
  now: number,
  ttlMs: number = DEFAULT_IDEMPOTENCY_TTL_MS,
): number {
  const result = db.prepare("DELETE FROM idempotency_keys WHERE created_at <= ?").run(now - ttlMs);
  return result.changes;
}
