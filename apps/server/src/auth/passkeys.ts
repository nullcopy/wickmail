import { randomUUID } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { SqliteDatabase } from "../db/database.js";

/** The default WebAuthn challenge lifetime: five minutes. */
export const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Relying-party configuration for WebAuthn. */
export interface PasskeyConfig {
  /** The relying-party ID, a domain such as `mail.example.com`. */
  rpID: string;
  /** The user-facing relying-party name. */
  rpName: string;
  /** The allowed origin, or origins, of the management app. */
  origin: string | string[];
}

/** A stored passkey credential. The public key is not a secret. */
export interface PasskeyRow {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[];
  name: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

interface RawPasskeyRow {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  transports: string;
  name: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

const SELECT_PASSKEY = `
  SELECT
    id AS id,
    user_id AS userId,
    credential_id AS credentialId,
    public_key AS publicKey,
    counter AS counter,
    transports AS transports,
    name AS name,
    created_at AS createdAt,
    last_used_at AS lastUsedAt
  FROM passkey_credentials
`;

function mapRow(row: RawPasskeyRow): PasskeyRow {
  return {
    id: row.id,
    userId: row.userId,
    credentialId: row.credentialId,
    publicKey: new Uint8Array(row.publicKey),
    counter: row.counter,
    transports: JSON.parse(row.transports) as string[],
    name: row.name,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

/** List a user's registered passkeys. */
export function listPasskeys(db: SqliteDatabase, userId: string): PasskeyRow[] {
  return (
    db
      .prepare(`${SELECT_PASSKEY} WHERE user_id = ? ORDER BY created_at ASC, id ASC`)
      .all(userId) as RawPasskeyRow[]
  ).map(mapRow);
}

/** Look up a passkey by its credential ID. */
export function getPasskeyByCredentialId(
  db: SqliteDatabase,
  credentialId: string,
): PasskeyRow | undefined {
  const row = db.prepare(`${SELECT_PASSKEY} WHERE credential_id = ?`).get(credentialId) as
    RawPasskeyRow | undefined;
  return row === undefined ? undefined : mapRow(row);
}

/** Delete a passkey owned by a user. Returns false when it does not exist. */
export function deletePasskey(db: SqliteDatabase, id: string, userId: string): boolean {
  const result = db
    .prepare("DELETE FROM passkey_credentials WHERE id = ? AND user_id = ?")
    .run(id, userId);
  return result.changes > 0;
}

/** Store a pending WebAuthn challenge, replacing older ones of the same kind. */
function storeChallenge(
  db: SqliteDatabase,
  input: {
    kind: "registration" | "authentication";
    challenge: string;
    userId: string;
    now: number;
  },
): void {
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM auth_challenges WHERE kind = ? AND user_id = ?").run(
      input.kind,
      input.userId,
    );
    db.prepare(
      `INSERT INTO auth_challenges (id, kind, challenge, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.kind,
      input.challenge,
      input.userId,
      input.now,
      input.now + DEFAULT_CHALLENGE_TTL_MS,
    );
  });
  replace();
}

/** Consume the most recent challenge of a kind. Expired challenges are discarded. */
function takeChallenge(
  db: SqliteDatabase,
  kind: "registration" | "authentication",
  now: number,
): string | undefined {
  const row = db
    .prepare(
      `SELECT id AS id, challenge AS challenge, expires_at AS expiresAt
       FROM auth_challenges WHERE kind = ? ORDER BY created_at DESC, id ASC LIMIT 1`,
    )
    .get(kind) as { id: string; challenge: string; expiresAt: number } | undefined;
  if (row === undefined) {
    return undefined;
  }
  db.prepare("DELETE FROM auth_challenges WHERE id = ?").run(row.id);
  if (row.expiresAt <= now) {
    return undefined;
  }
  return row.challenge;
}

/** Generate registration options and remember the challenge. */
export async function beginPasskeyRegistration(
  db: SqliteDatabase,
  config: PasskeyConfig,
  user: { id: string; username: string },
  now: number,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = listPasskeys(db, user.id).map((passkey) => ({
    id: passkey.credentialId,
    ...(passkey.transports.length > 0 ? { transports: passkey.transports } : {}),
  }));
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userName: user.username,
    userDisplayName: user.username,
    excludeCredentials: existing,
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  storeChallenge(db, {
    kind: "registration",
    challenge: options.challenge,
    userId: user.id,
    now,
  });
  return options;
}

/**
 * Verify a registration response and store the credential. Returns undefined
 * when the challenge is missing or the response does not verify.
 */
export async function finishPasskeyRegistration(
  db: SqliteDatabase,
  config: PasskeyConfig,
  user: { id: string },
  response: RegistrationResponseJSON,
  options: { name?: string; now: number },
): Promise<PasskeyRow | undefined> {
  const expectedChallenge = takeChallenge(db, "registration", options.now);
  if (expectedChallenge === undefined) {
    return undefined;
  }
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
    });
  } catch {
    return undefined;
  }
  if (!verification.verified) {
    return undefined;
  }
  const credential = verification.registrationInfo.credential;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO passkey_credentials (
       id, user_id, credential_id, public_key, counter, transports, name, created_at, last_used_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    user.id,
    credential.id,
    Buffer.from(credential.publicKey),
    credential.counter,
    JSON.stringify(credential.transports ?? []),
    options.name ?? null,
    options.now,
  );
  const row = db.prepare(`${SELECT_PASSKEY} WHERE id = ?`).get(id) as RawPasskeyRow;
  return mapRow(row);
}

/** Generate authentication options for a user's registered passkeys. */
export async function beginPasskeyAuthentication(
  db: SqliteDatabase,
  config: PasskeyConfig,
  user: { id: string },
  now: number,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const allowCredentials = listPasskeys(db, user.id).map((passkey) => ({
    id: passkey.credentialId,
    ...(passkey.transports.length > 0 ? { transports: passkey.transports } : {}),
  }));
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    allowCredentials,
    userVerification: "preferred",
  });
  storeChallenge(db, {
    kind: "authentication",
    challenge: options.challenge,
    userId: user.id,
    now,
  });
  return options;
}

/** The result of a verified passkey authentication. */
export interface PasskeyAuthentication {
  userId: string;
  passkey: PasskeyRow;
}

/**
 * Verify an authentication response and update the credential counter. Returns
 * undefined when the credential is unknown, the challenge is missing, or the
 * response does not verify.
 */
export async function finishPasskeyAuthentication(
  db: SqliteDatabase,
  config: PasskeyConfig,
  response: AuthenticationResponseJSON,
  now: number,
): Promise<PasskeyAuthentication | undefined> {
  const passkey = getPasskeyByCredentialId(db, response.id);
  if (passkey === undefined) {
    return undefined;
  }
  const expectedChallenge = takeChallenge(db, "authentication", now);
  if (expectedChallenge === undefined) {
    return undefined;
  }
  const credential: WebAuthnCredential = {
    id: passkey.credentialId,
    publicKey: passkey.publicKey,
    counter: passkey.counter,
    ...(passkey.transports.length > 0 ? { transports: passkey.transports } : {}),
  };
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      credential,
    });
  } catch {
    return undefined;
  }
  if (!verification.verified) {
    return undefined;
  }
  db.prepare("UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ?").run(
    verification.authenticationInfo.newCounter,
    now,
    passkey.id,
  );
  return {
    userId: passkey.userId,
    passkey: { ...passkey, counter: verification.authenticationInfo.newCounter, lastUsedAt: now },
  };
}

/** Remove challenges that have expired. */
export function purgeExpiredChallenges(db: SqliteDatabase, now: number): number {
  const result = db.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").run(now);
  return result.changes;
}
