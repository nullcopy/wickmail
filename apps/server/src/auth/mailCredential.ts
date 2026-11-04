import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../db/database.js";
import type { PasswordHasher } from "./password.js";

/** A stored mail credential. Its hash is separate from the management password. */
export interface MailCredentialRow {
  id: string;
  userId: string;
  createdAt: number;
  rotatedAt: number;
  revokedAt: number | null;
}

interface RawMailCredentialRow {
  id: string;
  userId: string;
  createdAt: number;
  rotatedAt: number;
  revokedAt: number | null;
}

const SELECT_CREDENTIAL = `
  SELECT
    id AS id,
    user_id AS userId,
    created_at AS createdAt,
    rotated_at AS rotatedAt,
    revoked_at AS revokedAt
  FROM mail_credentials
`;

/** The active mail credential for a user, or undefined. */
export function getActiveMailCredential(
  db: SqliteDatabase,
  userId: string,
): MailCredentialRow | undefined {
  return db
    .prepare(
      `${SELECT_CREDENTIAL} WHERE user_id = ? AND revoked_at IS NULL
       ORDER BY rotated_at DESC, id ASC LIMIT 1`,
    )
    .get(userId) as RawMailCredentialRow | undefined;
}

/** Every mail credential for a user, newest first. */
export function listMailCredentials(db: SqliteDatabase, userId: string): MailCredentialRow[] {
  return db
    .prepare(`${SELECT_CREDENTIAL} WHERE user_id = ? ORDER BY rotated_at DESC, id ASC`)
    .all(userId) as RawMailCredentialRow[];
}

/**
 * Rotate the mail credential: revoke the current one and store a new hash. The
 * mail credential is independent of the management password and can be revoked
 * without affecting management sessions.
 */
export function rotateMailCredential(
  db: SqliteDatabase,
  input: { userId: string; passwordHash: string; now: number },
): MailCredentialRow {
  const id = randomUUID();
  const rotate = db.transaction(() => {
    db.prepare(
      "UPDATE mail_credentials SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
    ).run(input.now, input.userId);
    db.prepare(
      `INSERT INTO mail_credentials (id, user_id, password_hash, created_at, rotated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(id, input.userId, input.passwordHash, input.now, input.now);
  });
  rotate();
  return db.prepare(`${SELECT_CREDENTIAL} WHERE id = ?`).get(id) as RawMailCredentialRow;
}

/** Revoke every active mail credential for a user. Returns how many were revoked. */
export function revokeMailCredential(db: SqliteDatabase, userId: string, now: number): number {
  const result = db
    .prepare("UPDATE mail_credentials SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
    .run(now, userId);
  return result.changes;
}

/** Whether a mail password matches the active mail credential. */
export async function verifyMailCredential(
  db: SqliteDatabase,
  userId: string,
  password: string,
  hasher: PasswordHasher,
): Promise<boolean> {
  const credential = getActiveMailCredential(db, userId);
  if (credential === undefined) {
    return false;
  }
  const row = db
    .prepare("SELECT password_hash AS passwordHash FROM mail_credentials WHERE id = ?")
    .get(credential.id) as { passwordHash: string };
  return hasher.verify(row.passwordHash, password);
}
