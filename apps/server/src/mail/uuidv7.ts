import { randomBytes } from "node:crypto";

const HEX = "0123456789abcdef";

function byteToHex(byte: number): string {
  return `${HEX[(byte >> 4) & 0x0f]}${HEX[byte & 0x0f]}`;
}

/**
 * Generate a UUIDv7: a 48-bit big-endian Unix timestamp in milliseconds
 * followed by random bits. The version and variant nibbles are set, so the
 * result is a valid, time-ordered UUID.
 *
 * Time-ordered identifiers keep message IDs roughly sortable by acceptance
 * time without leaking a client-supplied value.
 */
export function uuidv7(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0) {
    throw new RangeError(`uuidv7 requires a non-negative integer timestamp, got ${now}`);
  }
  const bytes = randomBytes(16);
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, byteToHex).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether a string is a UUID with version 7. */
export function isUuidv7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** The 48-bit timestamp encoded in a UUIDv7, in epoch milliseconds. */
export function uuidv7Timestamp(value: string): number {
  const compact = value.replace(/-/g, "");
  return Number.parseInt(compact.slice(0, 12), 16);
}
