import { describe, expect, it } from "vitest";
import { isUuidv7, uuidv7, uuidv7Timestamp } from "../src/mail/uuidv7.js";

describe("uuidv7", () => {
  it("produces a valid version 7 UUID with the RFC 4122 variant", () => {
    const id = uuidv7();
    expect(isUuidv7(id)).toBe(true);
    expect(id[14]).toBe("7");
    expect("89ab").toContain(id[19]);
  });

  it("encodes the supplied timestamp", () => {
    const now = Date.UTC(2026, 10, 3, 12, 0, 0);
    const id = uuidv7(now);
    expect(uuidv7Timestamp(id)).toBe(now);
  });

  it("generates unique IDs and stays time-ordered", () => {
    const earlier = uuidv7(1_000);
    const later = uuidv7(2_000);
    expect(earlier).not.toBe(later);
    expect(earlier < later).toBe(true);
  });

  it("rejects a negative timestamp", () => {
    expect(() => uuidv7(-1)).toThrow(RangeError);
  });
});
