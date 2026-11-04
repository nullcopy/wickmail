import { afterEach, describe, expect, it } from "vitest";
import { createAlias, type AliasRow } from "../src/alias/repository.js";
import { createUser } from "../src/auth/users.js";
import { createApiHarness, type ApiHarness } from "./api-helpers.js";
import { DAY_MS, NOW } from "./helpers.js";

let harness: ApiHarness;

afterEach(async () => {
  await harness?.close();
});

interface SeedInput {
  address: string;
  label?: string;
  purpose?: string | null;
  createdAt?: number;
  expiresAt?: number | null;
  disabledAt?: number | null;
  leaseDurationSeconds?: number;
  ownerId?: string | null;
}

function seed(h: ApiHarness, input: SeedInput): AliasRow {
  const alias = createAlias(h.db, {
    address: input.address,
    label: input.label ?? "Test Alias",
    purpose: input.purpose ?? null,
    createdAt: input.createdAt ?? NOW,
    expiresAt: input.expiresAt === undefined ? null : input.expiresAt,
    leaseDurationSeconds: input.leaseDurationSeconds ?? 3600,
    renewOnOutbound: true,
    ownerId: input.ownerId === undefined ? h.user!.id : input.ownerId,
  });
  if (input.disabledAt !== undefined && input.disabledAt !== null) {
    h.db.prepare("UPDATE aliases SET disabled_at = ? WHERE id = ?").run(input.disabledAt, alias.id);
  }
  return alias;
}

async function session(h: ApiHarness): Promise<{ cookie: Record<string, string>; csrf: string }> {
  const login = await h.login();
  return { cookie: h.cookie(login.sessionToken), csrf: login.csrfToken };
}

function mutateHeaders(h: ApiHarness, s: { cookie: Record<string, string>; csrf: string }) {
  return { ...s.cookie, "x-csrf-token": s.csrf };
}

describe("POST /v1/aliases", () => {
  it("creates an alias with a generated address", async () => {
    harness = await createApiHarness();
    const s = await session(harness);
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/aliases",
      headers: mutateHeaders(harness, s),
      payload: { label: "Example Store", lease: { type: "duration", durationSeconds: 3600 } },
    });
    expect(response.statusCode).toBe(201);
    const alias = (
      response.json() as { alias: { address: string; state: string; expiresAt: string } }
    ).alias;
    expect(alias.address.endsWith("@example.com")).toBe(true);
    expect(alias.state).toBe("active");
    expect(alias.expiresAt).toBe(new Date(NOW + 3600 * 1000).toISOString());
  });

  it("supports a no-expiry lease", async () => {
    harness = await createApiHarness();
    const s = await session(harness);
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/aliases",
      headers: mutateHeaders(harness, s),
      payload: { label: "Forever", lease: { type: "none" } },
    });
    expect(response.statusCode).toBe(201);
    expect((response.json() as { alias: { expiresAt: string | null } }).alias.expiresAt).toBeNull();
  });

  it("rejects a client-supplied address", async () => {
    harness = await createApiHarness();
    const s = await session(harness);
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/aliases",
      headers: mutateHeaders(harness, s),
      payload: { label: "x", address: "chosen@example.com" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("replays an idempotent creation", async () => {
    harness = await createApiHarness();
    const s = await session(harness);
    const headers = { ...mutateHeaders(harness, s), "idempotency-key": "create-1" };
    const first = await harness.app.inject({
      method: "POST",
      url: "/v1/aliases",
      headers,
      payload: { label: "Once" },
    });
    const second = await harness.app.inject({
      method: "POST",
      url: "/v1/aliases",
      headers,
      payload: { label: "Once" },
    });
    expect(first.statusCode).toBe(201);
    expect((second.json() as { alias: { id: string } }).alias.id).toBe(
      (first.json() as { alias: { id: string } }).alias.id,
    );
  });
});

describe("GET /v1/aliases", () => {
  it("filters by state, expiry presence, and search", async () => {
    harness = await createApiHarness();
    const s = await session(harness);
    seed(harness, { address: "active@example.com", label: "Active", expiresAt: NOW + DAY_MS });
    seed(harness, { address: "expired@example.com", label: "Old Store", expiresAt: NOW - DAY_MS });
    seed(harness, { address: "forever@example.com", label: "No Expiry", expiresAt: null });

    const expired = await harness.app.inject({
      method: "GET",
      url: "/v1/aliases?state=expired",
      headers: s.cookie,
    });
    expect((expired.json() as { aliases: unknown[] }).aliases).toHaveLength(1);

    const withExpiry = await harness.app.inject({
      method: "GET",
      url: "/v1/aliases?hasExpiry=true",
      headers: s.cookie,
    });
    expect((withExpiry.json() as { aliases: unknown[] }).aliases).toHaveLength(2);

    const search = await harness.app.inject({
      method: "GET",
      url: "/v1/aliases?search=store",
      headers: s.cookie,
    });
    expect((search.json() as { aliases: Array<{ address: string }> }).aliases[0]!.address).toBe(
      "expired@example.com",
    );
  });

  it("sorts by expiry with no-expiry aliases last", async () => {
    harness = await createApiHarness();
    const s = await session(harness);
    seed(harness, { address: "later@example.com", expiresAt: NOW + 1000 });
    seed(harness, { address: "none@example.com", expiresAt: null });
    seed(harness, { address: "sooner@example.com", expiresAt: NOW + 500 });

    const ascending = await harness.app.inject({
      method: "GET",
      url: "/v1/aliases?sort=expires&order=asc",
      headers: s.cookie,
    });
    expect(
      (ascending.json() as { aliases: Array<{ address: string }> }).aliases.map((a) => a.address),
    ).toEqual(["sooner@example.com", "later@example.com", "none@example.com"]);

    const descending = await harness.app.inject({
      method: "GET",
      url: "/v1/aliases?sort=expires&order=desc",
      headers: s.cookie,
    });
    expect(
      (descending.json() as { aliases: Array<{ address: string }> }).aliases.map((a) => a.address),
    ).toEqual(["later@example.com", "sooner@example.com", "none@example.com"]);
  });

  it("sorts by last used with never-used aliases ordered by creation time", async () => {
    harness = await createApiHarness();
    const s = await session(harness);
    const unused = seed(harness, { address: "unused@example.com", createdAt: NOW - 5000 });
    seed(harness, { address: "recent@example.com", createdAt: NOW - 4000 });
    harness.db
      .prepare("UPDATE aliases SET last_user_activity_at = ? WHERE address = ?")
      .run(NOW - 1000, "recent@example.com");

    const response = await harness.app.inject({
      method: "GET",
      url: "/v1/aliases?sort=lastUsed&order=asc",
      headers: s.cookie,
    });
    const addresses = (response.json() as { aliases: Array<{ address: string }> }).aliases.map(
      (a) => a.address,
    );
    expect(addresses).toEqual(["unused@example.com", "recent@example.com"]);
    expect(unused.createdAt).toBe(NOW - 5000);
  });

  it("paginates deterministically with a stable ID tiebreak", async () => {
    harness = await createApiHarness();
    const s = await session(harness);
    for (let index = 0; index < 5; index += 1) {
      seed(harness, {
        address: `alias-${index}@example.com`,
        createdAt: NOW + index,
      });
    }

    const first = await harness.app.inject({
      method: "GET",
      url: "/v1/aliases?limit=2&sort=created&order=asc",
      headers: s.cookie,
    });
    const firstBody = first.json() as { aliases: Array<{ id: string }>; nextCursor: string | null };
    expect(firstBody.aliases).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await harness.app.inject({
      method: "GET",
      url: `/v1/aliases?limit=2&sort=created&order=asc&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      headers: s.cookie,
    });
    const secondBody = second.json() as {
      aliases: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(secondBody.aliases).toHaveLength(2);
    const overlap = secondBody.aliases.filter((alias) =>
      firstBody.aliases.some((firstAlias) => firstAlias.id === alias.id),
    );
    expect(overlap).toHaveLength(0);
  });
});

describe("single-alias operations", () => {
  it("gets, patches, renews, extends, disables, and enables", async () => {
    harness = await createApiHarness();
    const s = await session(harness);
    const alias = seed(harness, { address: "green.farm@example.com", expiresAt: NOW + 1000 });

    const get = await harness.app.inject({
      method: "GET",
      url: `/v1/aliases/${alias.id}`,
      headers: s.cookie,
    });
    expect(get.statusCode).toBe(200);

    const patch = await harness.app.inject({
      method: "PATCH",
      url: `/v1/aliases/${alias.id}`,
      headers: mutateHeaders(harness, s),
      payload: { label: "Renamed", policyVersion: 0 },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { alias: { label: string; policyVersion: number } }).alias.label).toBe(
      "Renamed",
    );

    const stale = await harness.app.inject({
      method: "PATCH",
      url: `/v1/aliases/${alias.id}`,
      headers: mutateHeaders(harness, s),
      payload: { label: "Stale", policyVersion: 0 },
    });
    expect(stale.statusCode).toBe(409);

    const renew = await harness.app.inject({
      method: "POST",
      url: `/v1/aliases/${alias.id}/renew`,
      headers: mutateHeaders(harness, s),
      payload: {},
    });
    expect(renew.statusCode).toBe(200);
    expect((renew.json() as { alias: { expiresAt: string } }).alias.expiresAt).toBe(
      new Date(NOW + 3600 * 1000).toISOString(),
    );

    const extend = await harness.app.inject({
      method: "POST",
      url: `/v1/aliases/${alias.id}/extend`,
      headers: mutateHeaders(harness, s),
      payload: { durationSeconds: 60 },
    });
    expect(extend.statusCode).toBe(200);

    const disable = await harness.app.inject({
      method: "POST",
      url: `/v1/aliases/${alias.id}/disable`,
      headers: mutateHeaders(harness, s),
    });
    expect((disable.json() as { alias: { state: string } }).alias.state).toBe("disabled");

    const enable = await harness.app.inject({
      method: "POST",
      url: `/v1/aliases/${alias.id}/enable`,
      headers: mutateHeaders(harness, s),
      payload: {},
    });
    expect((enable.json() as { alias: { state: string } }).alias.state).toBe("active");
  });

  it("rejects extending an alias with no expiry", async () => {
    harness = await createApiHarness();
    const s = await session(harness);
    const alias = seed(harness, { address: "noexpiry@example.com", expiresAt: null });
    const response = await harness.app.inject({
      method: "POST",
      url: `/v1/aliases/${alias.id}/extend`,
      headers: mutateHeaders(harness, s),
      payload: {},
    });
    expect(response.statusCode).toBe(409);
  });

  it("lists lifecycle events", async () => {
    harness = await createApiHarness();
    const s = await session(harness);
    const alias = seed(harness, { address: "events@example.com", expiresAt: NOW + 1000 });
    harness.setNow(NOW);
    await harness.app.inject({
      method: "POST",
      url: `/v1/aliases/${alias.id}/renew`,
      headers: mutateHeaders(harness, s),
      payload: {},
    });
    harness.setNow(NOW + 1000);
    await harness.app.inject({
      method: "POST",
      url: `/v1/aliases/${alias.id}/disable`,
      headers: mutateHeaders(harness, s),
    });
    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/aliases/${alias.id}/events`,
      headers: s.cookie,
    });
    const events = (response.json() as { events: Array<{ type: string }> }).events;
    expect(events.map((event) => event.type)).toEqual(["renewed_manually", "disabled"]);
  });

  it("rejects an alias owned by another user", async () => {
    harness = await createApiHarness();
    const s = await session(harness);
    const otherUser = createUser(harness.db, { username: "other", now: NOW });
    const alias = seed(harness, {
      address: "other@example.com",
      ownerId: otherUser.id,
    });
    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/aliases/${alias.id}`,
      headers: s.cookie,
    });
    expect(response.statusCode).toBe(403);
  });

  it("returns 404 for an unknown alias", async () => {
    harness = await createApiHarness();
    const s = await session(harness);
    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/aliases/22222222-2222-4222-8222-222222222222`,
      headers: s.cookie,
    });
    expect(response.statusCode).toBe(404);
  });
});
