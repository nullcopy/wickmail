import assert from "node:assert/strict";
import { test } from "node:test";

import { filterQuarantine, isHeld, type QuarantineFilters } from "./quarantine.ts";
import { makeQuarantine } from "./testing.ts";

function filters(overrides: Partial<QuarantineFilters> = {}): QuarantineFilters {
  return { aliasId: "", search: "", from: "", to: "", ...overrides };
}

test("isHeld is true only for quarantined and recovering messages", () => {
  assert.equal(isHeld(makeQuarantine({ status: "quarantined" })), true);
  assert.equal(isHeld(makeQuarantine({ status: "recovering" })), true);
  assert.equal(isHeld(makeQuarantine({ status: "recovered" })), false);
  assert.equal(isHeld(makeQuarantine({ status: "deleted" })), false);
});

test("filterQuarantine filters by alias, date, and search", () => {
  const first = makeQuarantine({
    messageId: "m1",
    aliasIds: ["a"],
    sender: "store@example.com",
    receivedAt: "2026-01-02T00:00:00Z",
  });
  const second = makeQuarantine({
    messageId: "m2",
    aliasIds: ["b"],
    subject: "Invoice",
    receivedAt: "2026-01-10T00:00:00Z",
  });
  const items = [first, second];

  assert.deepEqual(
    filterQuarantine(items, filters({ aliasId: "a" })).map((item) => item.messageId),
    ["m1"],
  );
  assert.deepEqual(
    filterQuarantine(items, filters({ from: "2026-01-05" })).map((item) => item.messageId),
    ["m2"],
  );
  assert.deepEqual(
    filterQuarantine(items, filters({ search: "invoice" })).map((item) => item.messageId),
    ["m2"],
  );
});
