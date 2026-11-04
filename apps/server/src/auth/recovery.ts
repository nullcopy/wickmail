import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../db/database.js";
import { hashToken, newRecoveryCode, normalizeRecoveryCode } from "./tokens.js";

/** The default number of recovery codes issued at setup. */
export const DEFAULT_RECOVERY_CODE_COUNT = 10;

/**
 * Replace a user's recovery codes with a fresh set. The raw codes are returned
 * once and only their hashes are stored. Any unused code from a previous set is
 * invalidated.
 */
export function generateRecoveryCodes(
  db: SqliteDatabase,
  input: { userId: string; now: number; count?: number },
): string[] {
  const count = input.count ?? DEFAULT_RECOVERY_CODE_COUNT;
  const codes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    codes.push(newRecoveryCode());
  }

  const replace = db.transaction(() => {
    db.prepare("DELETE FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").run(
      input.userId,
    );
    const insert = db.prepare(
      `INSERT INTO recovery_codes (id, user_id, code_hash, created_at, used_at)
       VALUES (?, ?, ?, ?, NULL)`,
    );
    for (const code of codes) {
      insert.run(randomUUID(), input.userId, hashToken(normalizeRecoveryCode(code)), input.now);
    }
  });
  replace();

  return codes;
}

/**
 * Consume a one-time recovery code. A used, unknown, or malformed code returns
 * undefined.
 */
export function consumeRecoveryCode(
  db: SqliteDatabase,
  rawCode: string,
  now: number,
): { userId: string } | undefined {
  const normalized = normalizeRecoveryCode(rawCode);
  if (normalized.length === 0) {
    return undefined;
  }
  const consume = db.transaction(() => {
    const row = db
      .prepare(
        "SELECT user_id AS userId, used_at AS usedAt FROM recovery_codes WHERE code_hash = ?",
      )
      .get(hashToken(normalized)) as { userId: string; usedAt: number | null } | undefined;
    if (row === undefined || row.usedAt !== null) {
      return undefined;
    }
    db.prepare("UPDATE recovery_codes SET used_at = ? WHERE code_hash = ?").run(
      now,
      hashToken(normalized),
    );
    return { userId: row.userId };
  });
  return consume();
}

/** The number of unused recovery codes for a user. */
export function countUnusedRecoveryCodes(db: SqliteDatabase, userId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM recovery_codes WHERE user_id = ? AND used_at IS NULL")
    .get(userId) as { count: number };
  return row.count;
}
