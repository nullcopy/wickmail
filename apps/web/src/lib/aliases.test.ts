import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aliasCounts,
  filterAliases,
  quarantineCounts,
  sortAliases,
  type AliasFilters,
} from "./aliases.ts";
import { makeAlias, makeQuarantine } from "./testing.ts";

const NOW = Date.parse("2026-01-04T00:00:00Z");

function filters(overrides: Partial<AliasFilters> = {}): AliasFilters {
  return { search: "", states: [], expiry: { kind: "any" }, ...overrides };
}

test("sortAliases by expiry places no-expiry last and is deterministic", () => {
  const soon = makeAlias({ id: "b", label: "soon", expiresAt: "2026-01-05T00:00:00Z" });
  const later = makeAlias({ id: "c", label: "later", expiresAt: "2026-01-06T00:00:00Z" });
  const never = makeAlias({ id: "a", label: "never", expiresAt: null });
  const sorted = sortAliases([never, later, soon], "expires");
  assert.deepEqual(
    sorted.map((alias) => alias.label),
    ["soon", "later", "never"],
  );
});

test("sortAliases by recently used shows the latest first", () => {
  const older = makeAlias({ id: "a", label: "older", lastUsedAt: "2026-01-01T00:00:00Z" });
  const newer = makeAlias({ id: "b", label: "newer", lastUsedAt: "2026-01-03T00:00:00Z" });
  assert.deepEqual(
    sortAliases([older, newer], "lastUsed").map((alias) => alias.label),
    ["newer", "older"],
  );
});

test("filterAliases searches label, purpose, and address", () => {
  const alias = makeAlias({ label: "Example Store", purpose: "order #1234" });
  assert.equal(filterAliases([alias], filters({ search: "store" }), NOW).length, 1);
  assert.equal(filterAliases([alias], filters({ search: "1234" }), NOW).length, 1);
  assert.equal(filterAliases([alias], filters({ search: "green.farm" }), NOW).length, 1);
  assert.equal(filterAliases([alias], filters({ search: "missing" }), NOW).length, 0);
});

test("filterAliases applies state and expiry filters", () => {
  const active = makeAlias({ id: "a", state: "active", expiresAt: "2026-01-04T12:00:00Z" });
  const expired = makeAlias({ id: "b", state: "expired", expiresAt: "2026-01-02T00:00:00Z" });
  const never = makeAlias({ id: "c", state: "active", expiresAt: null });
  const aliases = [active, expired, never];

  assert.deepEqual(
    filterAliases(aliases, filters({ states: ["expired"] }), NOW).map((alias) => alias.id),
    ["b"],
  );
  assert.deepEqual(
    filterAliases(aliases, filters({ expiry: { kind: "none" } }), NOW).map((alias) => alias.id),
    ["c"],
  );
  assert.deepEqual(
    filterAliases(aliases, filters({ expiry: { kind: "within", seconds: 86400 } }), NOW).map(
      (alias) => alias.id,
    ),
    ["a", "b"],
  );
});

test("aliasCounts separates active, expiring-soon, expired, and disabled", () => {
  const aliases = [
    makeAlias({ id: "a", state: "active", expiresAt: "2026-01-04T12:00:00Z" }),
    makeAlias({ id: "b", state: "active", expiresAt: "2026-02-01T00:00:00Z" }),
    makeAlias({ id: "c", state: "active", expiresAt: null }),
    makeAlias({ id: "d", state: "expired" }),
    makeAlias({ id: "e", state: "disabled" }),
  ];
  assert.deepEqual(aliasCounts(aliases, 86400, NOW), {
    active: 3,
    expiringSoon: 1,
    expired: 1,
    disabled: 1,
  });
});

test("quarantineCounts counts held messages per alias", () => {
  const counts = quarantineCounts([
    makeQuarantine({ messageId: "m1", aliasIds: ["a"] }),
    makeQuarantine({ messageId: "m2", aliasIds: ["a", "b"] }),
    makeQuarantine({ messageId: "m3", status: "recovered", aliasIds: ["b"] }),
  ]);
  assert.equal(counts.get("a"), 2);
  assert.equal(counts.get("b"), 1);
});
