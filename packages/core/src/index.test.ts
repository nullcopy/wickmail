import assert from "node:assert/strict";
import { test } from "node:test";

import { API_CONTRACT_VERSION, isActive, type Alias } from "./index.ts";

const active: Alias = {
  id: "example",
  address: "green.farm@example.com",
  state: "active",
  expiresAt: "2026-01-01T00:00:00Z",
};

test("isActive reflects the server-computed state", () => {
  assert.equal(isActive(active), true);
  assert.equal(isActive({ ...active, state: "expired" }), false);
  assert.equal(isActive({ ...active, state: "disabled" }), false);
});

test("contract version is a non-empty string", () => {
  assert.equal(typeof API_CONTRACT_VERSION, "string");
  assert.ok(API_CONTRACT_VERSION.length > 0);
});
