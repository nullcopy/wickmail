import { describe, expect, it } from "vitest";
import { crossCheckRecipients, parsePathAddress, visibleRecipients } from "../src/mail/envelope.js";

describe("parsePathAddress", () => {
  it("unwraps angle brackets and preserves the null sender", () => {
    expect(parsePathAddress("<user@example.com>")).toBe("user@example.com");
    expect(parsePathAddress("user@example.com")).toBe("user@example.com");
    expect(parsePathAddress("<>")).toBe("");
  });
});

describe("visibleRecipients", () => {
  it("extracts canonical To and Cc addresses from folded, quoted headers", () => {
    const raw = [
      'To: "Store, Inc" <green.farm@example.com>,',
      "  second@example.com",
      "Cc: THIRD@EXAMPLE.COM",
      "",
      "body",
    ].join("\r\n");
    expect(visibleRecipients(raw)).toEqual([
      "green.farm@example.com",
      "second@example.com",
      "third@example.com",
    ]);
  });
});

describe("crossCheckRecipients", () => {
  it("reports blind copies as envelope-only", () => {
    const raw = ["To: green.farm@example.com", "", "body"].join("\r\n");
    const result = crossCheckRecipients(["green.farm@example.com", "secret@example.com"], raw);
    expect(result.envelope).toEqual(["green.farm@example.com", "secret@example.com"]);
    expect(result.envelopeOnly).toEqual(["secret@example.com"]);
    expect(result.visibleOnly).toEqual([]);
  });

  it("reports visible recipients missing from the envelope", () => {
    const raw = ["To: visible@example.com", "", "body"].join("\r\n");
    const result = crossCheckRecipients(["green.farm@example.com"], raw);
    expect(result.visibleOnly).toEqual(["visible@example.com"]);
    expect(result.envelopeOnly).toEqual(["green.farm@example.com"]);
  });

  it("deduplicates and canonicalizes both sides", () => {
    const raw = ["To: GREEN.FARM@EXAMPLE.COM", "", "body"].join("\r\n");
    const result = crossCheckRecipients(["green.farm@example.com", "GREEN.FARM@example.com"], raw);
    expect(result.envelope).toEqual(["green.farm@example.com"]);
    expect(result.visible).toEqual(["green.farm@example.com"]);
    expect(result.envelopeOnly).toEqual([]);
  });
});
