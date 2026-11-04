import assert from "node:assert/strict";
import { test } from "node:test";

import { filterMessages, type MessageFilters } from "./messages.ts";
import { makeMessage } from "./testing.ts";

function filters(overrides: Partial<MessageFilters> = {}): MessageFilters {
  return { aliasId: "", search: "", from: "", to: "", ...overrides };
}

test("filterMessages filters by alias, search, and date", () => {
  const first = makeMessage({
    messageId: "m1",
    aliasIds: ["a"],
    sender: "store@example.com",
    receivedAt: "2026-01-02T00:00:00Z",
  });
  const second = makeMessage({
    messageId: "m2",
    aliasIds: ["b"],
    subject: "Invoice",
    receivedAt: "2026-01-10T00:00:00Z",
  });
  const items = [first, second];

  assert.deepEqual(
    filterMessages(items, filters({ aliasId: "b" })).map((item) => item.messageId),
    ["m2"],
  );
  assert.deepEqual(
    filterMessages(items, filters({ to: "2026-01-05" })).map((item) => item.messageId),
    ["m1"],
  );
  assert.deepEqual(
    filterMessages(items, filters({ search: "invoice" })).map((item) => item.messageId),
    ["m2"],
  );
});
