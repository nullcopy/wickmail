import { randomUUID } from "node:crypto";
import type { ApiScope } from "wickmail-core";
import { apiScopeSchema } from "wickmail-core";
import type { SqliteDatabase } from "../db/database.js";
import { hashToken, newApiTokenSecret } from "./tokens.js";

/** A stored API token. Only its hash is stored; the secret is shown once. */
export interface ApiTokenRow {
  id: string;
  /** The owning user, or null for a token created before ownership was recorded. */
  userId: string | null;
  name: string;
  scopes: ApiScope[];
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

interface RawApiTokenRow {
  id: string;
  userId: string | null;
  name: string;
  scopes: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

const SELECT_TOKEN = `
  SELECT
    id AS id,
    user_id AS userId,
    name AS name,
    scopes AS scopes,
    created_at AS createdAt,
    expires_at AS expiresAt,
    revoked_at AS revokedAt,
    last_used_at AS lastUsedAt
  FROM api_tokens
`;

function parseScopes(raw: string): ApiScope[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  const scopes: ApiScope[] = [];
  for (const value of parsed) {
    const result = apiScopeSchema.safeParse(value);
    if (result.success) {
      scopes.push(result.data);
    }
  }
  return scopes;
}

function mapRow(row: RawApiTokenRow): ApiTokenRow {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    scopes: parseScopes(row.scopes),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
  };
}

/** A newly created token and its one-time secret. */
export interface CreatedApiToken {
  token: ApiTokenRow;
  /** The raw token; shown once and never stored. */
  secret: string;
}

/** Create a scoped API token. */
export function createApiToken(
  db: SqliteDatabase,
  input: {
    userId: string;
    name: string;
    scopes: readonly ApiScope[];
    now: number;
    expiresAt?: number | null;
  },
): CreatedApiToken {
  const scopes = input.scopes.map((scope) => apiScopeSchema.parse(scope));
  const secret = newApiTokenSecret();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at, expires_at, revoked_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(
    id,
    input.userId,
    input.name,
    hashToken(secret),
    JSON.stringify(scopes),
    input.now,
    input.expiresAt ?? null,
  );
  const row = db.prepare(`${SELECT_TOKEN} WHERE id = ?`).get(id) as RawApiTokenRow;
  return { token: mapRow(row), secret };
}

/** Fetch a token by ID, or undefined. */
export function getApiTokenById(db: SqliteDatabase, id: string): ApiTokenRow | undefined {
  const row = db.prepare(`${SELECT_TOKEN} WHERE id = ?`).get(id) as RawApiTokenRow | undefined;
  return row === undefined ? undefined : mapRow(row);
}

/**
 * Resolve a raw API token to a live token record. A revoked or expired token
 * resolves to undefined; a live one has its `last_used_at` refreshed.
 */
export function verifyApiToken(
  db: SqliteDatabase,
  rawToken: string,
  now: number,
): ApiTokenRow | undefined {
  const row = db.prepare(`${SELECT_TOKEN} WHERE token_hash = ?`).get(hashToken(rawToken)) as
    RawApiTokenRow | undefined;
  if (row === undefined || row.revokedAt !== null || row.userId === null) {
    return undefined;
  }
  if (row.expiresAt !== null && row.expiresAt <= now) {
    return undefined;
  }
  db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
  return { ...mapRow(row), lastUsedAt: now };
}

/** List every API token, newest first. Revoked tokens are included for audit. */
export function listApiTokens(db: SqliteDatabase): ApiTokenRow[] {
  return (
    db.prepare(`${SELECT_TOKEN} ORDER BY created_at DESC, id ASC`).all() as RawApiTokenRow[]
  ).map(mapRow);
}

/** Revoke a token. Returns false when it does not exist or is already revoked. */
export function revokeApiToken(db: SqliteDatabase, id: string, now: number): boolean {
  const result = db
    .prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(now, id);
  return result.changes > 0;
}
