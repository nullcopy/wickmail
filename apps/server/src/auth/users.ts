import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../db/database.js";

/** A stored management user. */
export interface UserRow {
  id: string;
  username: string;
  passwordHash: string | null;
  createdAt: number;
  updatedAt: number;
}

interface RawUserRow {
  id: string;
  username: string;
  passwordHash: string | null;
  createdAt: number;
  updatedAt: number;
}

const SELECT_USER = `
  SELECT
    id AS id,
    username AS username,
    password_hash AS passwordHash,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM users
`;

/** Thrown when a user does not exist. */
export class UserNotFoundError extends Error {
  override name = "UserNotFoundError";

  constructor(readonly userId: string) {
    super(`user not found: ${userId}`);
  }
}

/** Whether any user exists yet. Bootstrap runs only when this is false. */
export function hasAnyUser(db: SqliteDatabase): boolean {
  const row = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  return row.count > 0;
}

/** The number of management users. */
export function countUsers(db: SqliteDatabase): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  return row.count;
}

/** Fetch a user by ID, or undefined. */
export function getUserById(db: SqliteDatabase, id: string): UserRow | undefined {
  return db.prepare(`${SELECT_USER} WHERE id = ?`).get(id) as RawUserRow | undefined;
}

/** Fetch a user by username, case-insensitively, or undefined. */
export function getUserByUsername(db: SqliteDatabase, username: string): UserRow | undefined {
  return db.prepare(`${SELECT_USER} WHERE username = ? COLLATE NOCASE`).get(username.trim()) as
    RawUserRow | undefined;
}

/** Fetch the sole user, or undefined when bootstrap has not run. */
export function getSoleUser(db: SqliteDatabase): UserRow | undefined {
  return db.prepare(`${SELECT_USER} ORDER BY created_at ASC, id ASC LIMIT 1`).get() as
    RawUserRow | undefined;
}

/** Fetch a user by ID, throwing when it does not exist. */
export function requireUser(db: SqliteDatabase, id: string): UserRow {
  const user = getUserById(db, id);
  if (user === undefined) {
    throw new UserNotFoundError(id);
  }
  return user;
}

/** Create the management user. No password is set until setup is completed. */
export function createUser(db: SqliteDatabase, input: { username: string; now: number }): UserRow {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?)`,
  ).run(id, input.username.trim(), input.now, input.now);
  return requireUser(db, id);
}

/** Set or replace the management password hash. */
export function setPasswordHash(
  db: SqliteDatabase,
  userId: string,
  passwordHash: string,
  now: number,
): UserRow {
  const result = db
    .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
    .run(passwordHash, now, userId);
  if (result.changes === 0) {
    throw new UserNotFoundError(userId);
  }
  return requireUser(db, userId);
}

/** Change a user's username. */
export function updateUsername(
  db: SqliteDatabase,
  userId: string,
  username: string,
  now: number,
): UserRow {
  const result = db
    .prepare("UPDATE users SET username = ?, updated_at = ? WHERE id = ?")
    .run(username.trim(), now, userId);
  if (result.changes === 0) {
    throw new UserNotFoundError(userId);
  }
  return requireUser(db, userId);
}
