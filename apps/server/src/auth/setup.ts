import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../db/database.js";
import { hashToken, newSetupTokenSecret } from "./tokens.js";

/** The default setup-token lifetime: one hour. */
export const DEFAULT_SETUP_TOKEN_TTL_MS = 60 * 60 * 1000;

/** A consumed setup token, or undefined when the token is invalid. */
export interface ConsumedSetupToken {
  userId: string;
}

/**
 * Create a single-use setup token for a user. The raw token is returned once
 * and only its hash is stored, so a leaked database cannot be replayed.
 */
export function createSetupToken(
  db: SqliteDatabase,
  input: { userId: string; now: number; ttlMs?: number },
): string {
  const secret = newSetupTokenSecret();
  const expiresAt = input.now + (input.ttlMs ?? DEFAULT_SETUP_TOKEN_TTL_MS);
  db.prepare(
    `INSERT INTO setup_tokens (id, user_id, token_hash, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(randomUUID(), input.userId, hashToken(secret), input.now, expiresAt);
  return secret;
}

/**
 * Consume a setup token. A token is valid only once: a second use, an expired
 * token, or an unknown token all return undefined.
 */
export function consumeSetupToken(
  db: SqliteDatabase,
  rawToken: string,
  now: number,
): ConsumedSetupToken | undefined {
  const tokenHash = hashToken(rawToken);
  const consume = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT user_id AS userId, expires_at AS expiresAt, used_at AS usedAt
         FROM setup_tokens WHERE token_hash = ?`,
      )
      .get(tokenHash) as
      { userId: string; expiresAt: number | null; usedAt: number | null } | undefined;
    if (row === undefined || row.usedAt !== null) {
      return undefined;
    }
    if (row.expiresAt !== null && row.expiresAt <= now) {
      return undefined;
    }
    db.prepare("UPDATE setup_tokens SET used_at = ? WHERE token_hash = ?").run(now, tokenHash);
    return { userId: row.userId };
  });
  return consume();
}

/** The number of setup tokens that are still unused and unexpired. */
export function countActiveSetupTokens(db: SqliteDatabase, now: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM setup_tokens
       WHERE used_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(now) as { count: number };
  return row.count;
}
