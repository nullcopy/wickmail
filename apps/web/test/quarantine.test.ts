import { describe, expect, it } from "vitest";
import {
  filterQuarantine,
  retentionDeadline,
  sortQuarantineByReceived,
} from "../src/lib/quarantine.js";
import { DAY_MS, NOW, makeMessage } from "./helpers.js";

const older = makeMessage({
  messageId: "older",
  aliasIds: ["a"],
  sender: "alpha@example.net",
  subject: "Invoice",
  receivedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
});

const newer = makeMessage({
  messageId: "newer",
  aliasIds: ["b"],
  sender: "beta@example.net",
  subject: "Shipping update",
  receivedAt: new Date(NOW - DAY_MS).toISOString(),
});

describe("filterQuarantine", () => {
  it("filters by alias", () => {
    const result = filterQuarantine([older, newer], {
      aliasId: "b",
      search: "",
      from: "",
      to: "",
    });
    expect(result.map((message) => message.messageId)).toEqual(["newer"]);
  });

  it("searches sender and subject case-insensitively", () => {
    const result = filterQuarantine([older, newer], {
      aliasId: "all",
      search: "invoice",
      from: "",
      to: "",
    });
    expect(result.map((message) => message.messageId)).toEqual(["older"]);
  });

  it("filters by an inclusive received-date window", () => {
    const from = new Date(NOW - 5 * DAY_MS).toISOString().slice(0, 10);
    const to = new Date(NOW).toISOString().slice(0, 10);
    const result = filterQuarantine([older, newer], {
      aliasId: "all",
      search: "",
      from,
      to,
    });
    expect(result.map((message) => message.messageId)).toEqual(["newer"]);
  });
});

describe("sortQuarantineByReceived", () => {
  it("sorts newest first with a stable ID tiebreak", () => {
    const same = makeMessage({
      messageId: "aaa",
      receivedAt: newer.receivedAt,
    });
    const sorted = sortQuarantineByReceived([older, newer, same]);
    expect(sorted.map((message) => message.messageId)).toEqual(["aaa", "newer", "older"]);
  });
});

describe("retentionDeadline", () => {
  it("returns the quarantine expiry", () => {
    expect(retentionDeadline(newer)).toBe(newer.quarantineExpiresAt);
    expect(retentionDeadline(makeMessage({ quarantineExpiresAt: null }))).toBeNull();
  });
});
