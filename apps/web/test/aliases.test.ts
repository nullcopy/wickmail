import { describe, expect, it } from "vitest";
import type { Alias } from "wickmail-core";
import {
  aliasSortValue,
  countQuarantineByAlias,
  DEFAULT_ALIAS_CRITERIA,
  deriveAliasQuery,
  deriveDashboardCounts,
  isExpiringSoon,
  sortAliases,
} from "../src/lib/aliases.js";
import { DAY_MS, NOW, makeAlias, makeMessage } from "./helpers.js";

function aliasAt(overrides: Partial<Alias>): Alias {
  return makeAlias(overrides);
}

describe("deriveAliasQuery", () => {
  it("defaults to expiry ascending with a page limit", () => {
    const query = deriveAliasQuery(DEFAULT_ALIAS_CRITERIA, "expires", NOW);
    expect(query).toMatchObject({ sort: "expires", order: "asc", limit: 200 });
    expect(query.search).toBeUndefined();
    expect(query.state).toBeUndefined();
    expect(query.hasExpiry).toBeUndefined();
  });

  it("maps state, search, and sort", () => {
    const query = deriveAliasQuery(
      { ...DEFAULT_ALIAS_CRITERIA, state: "expired", search: "  merchant  " },
      "lastUsed",
      NOW,
    );
    expect(query.state).toBe("expired");
    expect(query.search).toBe("merchant");
    expect(query.sort).toBe("lastUsed");
    expect(query.order).toBe("desc");
  });

  it("maps the 24-hour and 7-day expiry windows", () => {
    const day = deriveAliasQuery({ ...DEFAULT_ALIAS_CRITERIA, expiry: "24h" }, "expires", NOW);
    expect(day.hasExpiry).toBe(true);
    expect(day.expiresAfter).toBe(new Date(NOW).toISOString());
    expect(day.expiresBefore).toBe(new Date(NOW + DAY_MS).toISOString());

    const week = deriveAliasQuery({ ...DEFAULT_ALIAS_CRITERIA, expiry: "7d" }, "expires", NOW);
    expect(week.expiresBefore).toBe(new Date(NOW + 7 * DAY_MS).toISOString());
  });

  it("selects only aliases without expiry for the no-expiry filter", () => {
    const query = deriveAliasQuery({ ...DEFAULT_ALIAS_CRITERIA, expiry: "none" }, "expires", NOW);
    expect(query.hasExpiry).toBe(false);
    expect(query.expiresAfter).toBeUndefined();
  });

  it("maps a custom range to inclusive day bounds", () => {
    const query = deriveAliasQuery(
      {
        ...DEFAULT_ALIAS_CRITERIA,
        expiry: "custom",
        customAfter: "2026-11-01",
        customBefore: "2026-11-30",
      },
      "expires",
      NOW,
    );
    expect(query.expiresAfter).toBe("2026-11-01T00:00:00.000Z");
    expect(query.expiresBefore).toBe("2026-11-30T23:59:59.999Z");
  });
});

describe("sortAliases", () => {
  it("sorts by expiry ascending with no-expiry aliases last", () => {
    const soon = aliasAt({ id: "b", expiresAt: new Date(NOW + DAY_MS).toISOString() });
    const later = aliasAt({ id: "c", expiresAt: new Date(NOW + 3 * DAY_MS).toISOString() });
    const forever = aliasAt({ id: "a", expiresAt: null });
    const sorted = sortAliases([forever, later, soon], "expires");
    expect(sorted.map((alias) => alias.id)).toEqual(["b", "c", "a"]);
  });

  it("keeps no-expiry aliases last for descending expiry too", () => {
    const soon = aliasAt({ id: "b", expiresAt: new Date(NOW + DAY_MS).toISOString() });
    const later = aliasAt({ id: "c", expiresAt: new Date(NOW + 3 * DAY_MS).toISOString() });
    const forever = aliasAt({ id: "a", expiresAt: null });
    const sorted = sortAliases([forever, later, soon], "expires", "desc");
    expect(sorted.map((alias) => alias.id)).toEqual(["c", "b", "a"]);
  });

  it("breaks ties by alias ID for a stable order", () => {
    const first = aliasAt({ id: "aaa", expiresAt: new Date(NOW + DAY_MS).toISOString() });
    const second = aliasAt({ id: "bbb", expiresAt: new Date(NOW + DAY_MS).toISOString() });
    const sorted = sortAliases([second, first], "expires");
    expect(sorted.map((alias) => alias.id)).toEqual(["aaa", "bbb"]);
  });

  it("sorts recently used with never-used aliases falling back to creation time", () => {
    const used = aliasAt({
      id: "a",
      createdAt: new Date(NOW - 10 * DAY_MS).toISOString(),
      lastInboundAt: new Date(NOW - 2 * DAY_MS).toISOString(),
    });
    const recentlyCreated = aliasAt({
      id: "b",
      createdAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
    });
    const activeUser = aliasAt({
      id: "c",
      createdAt: new Date(NOW - 5 * DAY_MS).toISOString(),
      lastUserActivityAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    });
    const sorted = sortAliases([used, recentlyCreated, activeUser], "lastUsed");
    expect(sorted.map((alias) => alias.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts recently created descending", () => {
    const old = aliasAt({ id: "a", createdAt: new Date(NOW - 10 * DAY_MS).toISOString() });
    const recent = aliasAt({ id: "b", createdAt: new Date(NOW - DAY_MS).toISOString() });
    const sorted = sortAliases([old, recent], "created");
    expect(sorted.map((alias) => alias.id)).toEqual(["b", "a"]);
  });

  it("reports the last-used fallback as the creation time", () => {
    const created = new Date(NOW - DAY_MS).toISOString();
    const alias = aliasAt({ createdAt: created, lastInboundAt: null, lastUserActivityAt: null });
    expect(aliasSortValue(alias, "lastUsed")).toBe(Date.parse(created));
  });
});

describe("isExpiringSoon", () => {
  it("counts only active aliases inside the threshold", () => {
    const soon = aliasAt({ expiresAt: new Date(NOW + DAY_MS).toISOString() });
    const far = aliasAt({ expiresAt: new Date(NOW + 20 * DAY_MS).toISOString() });
    const noExpiry = aliasAt({ expiresAt: null });
    const expired = aliasAt({
      state: "expired",
      expiresAt: new Date(NOW - DAY_MS).toISOString(),
    });
    expect(isExpiringSoon(soon, NOW, 7 * DAY_MS)).toBe(true);
    expect(isExpiringSoon(far, NOW, 7 * DAY_MS)).toBe(false);
    expect(isExpiringSoon(noExpiry, NOW, 7 * DAY_MS)).toBe(false);
    expect(isExpiringSoon(expired, NOW, 7 * DAY_MS)).toBe(false);
  });
});

describe("deriveDashboardCounts", () => {
  it("counts effective states and quarantined messages", () => {
    const aliases = [
      aliasAt({ id: "a", state: "active", expiresAt: new Date(NOW + DAY_MS).toISOString() }),
      aliasAt({ id: "b", state: "active", expiresAt: null }),
      aliasAt({ id: "c", state: "expired", expiresAt: new Date(NOW - DAY_MS).toISOString() }),
      aliasAt({ id: "d", state: "disabled", expiresAt: null }),
    ];
    const messages = [
      makeMessage({ messageId: "m1", aliasIds: ["a"] }),
      makeMessage({ messageId: "m2", aliasIds: ["a", "b"] }),
      makeMessage({ messageId: "m3", aliasIds: ["c"], status: "recovered" }),
    ];
    const counts = deriveDashboardCounts(
      aliases,
      countQuarantineByAlias(messages),
      NOW,
      7 * DAY_MS,
    );
    expect(counts).toEqual({ active: 2, expiringSoon: 1, expired: 1, disabled: 1, quarantined: 3 });
  });
});
