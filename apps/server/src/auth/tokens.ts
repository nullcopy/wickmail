import { createHash, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

/** The prefix carried by every management API token. */
export const API_TOKEN_PREFIX = "wmk_";

/** The prefix carried by a single-use setup token. */
export const SETUP_TOKEN_PREFIX = "wmksetup_";

/**
 * A URL-safe random token. Tokens are opaque bearer secrets: the server stores
 * only their hash, so the raw value is shown once and never persisted.
 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** A fresh API token secret, including its recognisable prefix. */
export function newApiTokenSecret(): string {
  return `${API_TOKEN_PREFIX}${randomToken(32)}`;
}

/** A fresh single-use setup token, including its recognisable prefix. */
export function newSetupTokenSecret(): string {
  return `${SETUP_TOKEN_PREFIX}${randomToken(32)}`;
}

/** The hex SHA-256 of a token. Stored at rest in place of the raw value. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of two token hashes or secrets. */
export function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return nodeTimingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * A human-transcribable recovery code: three groups of five base32 characters.
 * Recovery codes are one-time secrets, so only their hash is stored.
 */
export function newRecoveryCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(15);
  let code = "";
  for (let index = 0; index < 15; index += 1) {
    const byte = bytes[index]!;
    code += alphabet[byte % alphabet.length];
    if (index % 5 === 4 && index !== 14) {
      code += "-";
    }
  }
  return code;
}

/** Normalize a recovery code for lookup: uppercase and strip separators. */
export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, "");
}
