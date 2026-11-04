import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../db/database.js";
import { hashToken, randomToken } from "./tokens.js";

/** The default session lifetime: 30 days. */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A stored, revocable session. */
export interface SessionRow {
  id: string;
  userId: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  userAgent: string | null;
}

interface RawSessionRow {
  id: string;
  userId: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  userAgent: string | null;
}

const SELECT_SESSION = `
  SELECT
    id AS id,
    user_id AS userId,
    csrf_token AS csrfToken,
    created_at AS createdAt,
    expires_at AS expiresAt,
    last_used_at AS lastUsedAt,
    revoked_at AS revokedAt,
    user_agent AS userAgent
  FROM sessions
`;

/** A freshly created session and its bearer token. The token is shown once. */
export interface CreatedSession {
  session: SessionRow;
  /** The raw session token; only its hash is stored. */
  token: string;
}

/** Create a session. The cookie carries the returned token. */
export function createSession(
  db: SqliteDatabase,
  input: { userId: string; now: number; ttlMs?: number; userAgent?: string | null },
): CreatedSession {
  const id = randomUUID();
  const token = randomToken(32);
  const csrfToken = randomToken(32);
  const expiresAt = input.now + (input.ttlMs ?? DEFAULT_SESSION_TTL_MS);
  db.prepare(
    `INSERT INTO sessions (
       id, user_id, token_hash, csrf_token, created_at, expires_at, last_used_at, revoked_at, user_agent
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(
    id,
    input.userId,
    hashToken(token),
    csrfToken,
    input.now,
    expiresAt,
    input.userAgent ?? null,
  );
  return { session: requireSession(db, id), token };
}

/** Fetch a session by ID, or undefined. */
export function getSessionById(db: SqliteDatabase, id: string): SessionRow | undefined {
  return db.prepare(`${SELECT_SESSION} WHERE id = ?`).get(id) as RawSessionRow | undefined;
}

/** Fetch a session by ID, throwing when it does not exist. */
export function requireSession(db: SqliteDatabase, id: string): SessionRow {
  const session = getSessionById(db, id);
  if (session === undefined) {
    throw new SessionNotFoundError(id);
  }
  return session;
}

/** Thrown when a session does not exist. */
export class SessionNotFoundError extends Error {
  override name = "SessionNotFoundError";

  constructor(readonly sessionId: string) {
    super(`session not found: ${sessionId}`);
  }
}

/**
 * Resolve a raw session token to a live session. A revoked or expired session
 * resolves to undefined; a live one has its `last_used_at` refreshed.
 */
export function verifySession(
  db: SqliteDatabase,
  rawToken: string,
  now: number,
): SessionRow | undefined {
  const row = db.prepare(`${SELECT_SESSION} WHERE token_hash = ?`).get(hashToken(rawToken)) as
    RawSessionRow | undefined;
  if (row === undefined || row.revokedAt !== null || row.expiresAt <= now) {
    return undefined;
  }
  db.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?").run(now, row.id);
  return { ...row, lastUsedAt: now };
}

/** Revoke a session. Returns false when the session does not exist. */
export function revokeSession(db: SqliteDatabase, id: string, now: number): boolean {
  const result = db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(now, id);
  return result.changes > 0;
}

/**
 * Revoke every live session for a user, optionally keeping one (for example
 * the session that just changed the password).
 */
export function revokeUserSessions(
  db: SqliteDatabase,
  userId: string,
  now: number,
  exceptSessionId?: string,
): number {
  const result =
    exceptSessionId === undefined
      ? db
          .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
          .run(now, userId)
      : db
          .prepare(
            `UPDATE sessions SET revoked_at = ?
             WHERE user_id = ? AND revoked_at IS NULL AND id != ?`,
          )
          .run(now, userId, exceptSessionId);
  return result.changes;
}

/** List a user's live sessions, most recent first. */
export function listSessions(db: SqliteDatabase, userId: string, now: number): SessionRow[] {
  return db
    .prepare(
      `${SELECT_SESSION}
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC, id ASC`,
    )
    .all(userId, now) as RawSessionRow[];
}

/** Delete sessions that have expired or been revoked for longer than a grace period. */
export function purgeDeadSessions(db: SqliteDatabase, now: number, graceMs: number): number {
  const result = db
    .prepare(
      `DELETE FROM sessions
       WHERE (expires_at <= ? OR revoked_at IS NOT NULL) AND COALESCE(revoked_at, expires_at) <= ?`,
    )
    .run(now, now - graceMs);
  return result.changes;
}
