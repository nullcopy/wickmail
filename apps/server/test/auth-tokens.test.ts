import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApiHarness, type ApiHarness } from "./api-helpers.js";

let harness: ApiHarness;

afterEach(async () => {
  await harness?.close();
});

async function createToken(
  h: ApiHarness,
  body: Record<string, unknown>,
): Promise<{ status: number; secret: string; id: string }> {
  const login = await h.login();
  const response = await h.app.inject({
    method: "POST",
    url: "/v1/auth/tokens",
    headers: { ...h.cookie(login.sessionToken), "x-csrf-token": login.csrfToken },
    payload: body,
  });
  const parsed = response.json() as { secret?: string; token?: { id: string } };
  return {
    status: response.statusCode,
    secret: parsed.secret ?? "",
    id: parsed.token?.id ?? "",
  };
}

describe("scoped API tokens", () => {
  it("creates a token, stores only its hash, and shows the secret once", async () => {
    harness = await createApiHarness();
    const created = await createToken(harness, { name: "read only", scopes: ["aliases:read"] });
    expect(created.status).toBe(201);
    expect(created.secret.startsWith("wmk_")).toBe(true);

    const row = harness.db
      .prepare("SELECT token_hash AS hash FROM api_tokens WHERE id = ?")
      .get(created.id) as { hash: string };
    expect(row.hash).not.toBe(created.secret);
    expect(row.hash).toBe(createHash("sha256").update(created.secret).digest("hex"));

    const login = await harness.login();
    const list = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/tokens",
      headers: harness.cookie(login.sessionToken),
    });
    const body = list.json() as { tokens: Array<Record<string, unknown>> };
    expect(body.tokens).toHaveLength(1);
    expect(JSON.stringify(body.tokens)).not.toContain(created.secret);
  });

  it("enforces scopes and exempts bearer tokens from CSRF", async () => {
    harness = await createApiHarness();
    const read = await createToken(harness, { name: "read", scopes: ["aliases:read"] });

    const list = await harness.app.inject({
      method: "GET",
      url: "/v1/aliases",
      headers: { authorization: `Bearer ${read.secret}` },
    });
    expect(list.statusCode).toBe(200);

    const create = await harness.app.inject({
      method: "POST",
      url: "/v1/aliases",
      headers: { authorization: `Bearer ${read.secret}` },
      payload: { label: "not allowed" },
    });
    expect(create.statusCode).toBe(403);
    expect((create.json() as { error: { code: string } }).error.code).toBe("forbidden");
  });

  it("revokes a token", async () => {
    harness = await createApiHarness();
    const created = await createToken(harness, { name: "temp", scopes: ["aliases:read"] });
    const login = await harness.login();
    const revoke = await harness.app.inject({
      method: "DELETE",
      url: `/v1/auth/tokens/${created.id}`,
      headers: { ...harness.cookie(login.sessionToken), "x-csrf-token": login.csrfToken },
    });
    expect(revoke.statusCode).toBe(204);

    const use = await harness.app.inject({
      method: "GET",
      url: "/v1/aliases",
      headers: { authorization: `Bearer ${created.secret}` },
    });
    expect(use.statusCode).toBe(401);
  });

  it("rejects an expired token", async () => {
    harness = await createApiHarness();
    const created = await createToken(harness, {
      name: "expired",
      scopes: ["aliases:read"],
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(created.status).toBe(201);
    const use = await harness.app.inject({
      method: "GET",
      url: "/v1/aliases",
      headers: { authorization: `Bearer ${created.secret}` },
    });
    expect(use.statusCode).toBe(401);
  });

  it("validates requested scopes", async () => {
    harness = await createApiHarness();
    expect((await createToken(harness, { name: "empty", scopes: [] })).status).toBe(400);
    expect((await createToken(harness, { name: "bad", scopes: ["everything"] })).status).toBe(400);
  });

  it("does not let a scoped token manage credentials", async () => {
    harness = await createApiHarness();
    const read = await createToken(harness, { name: "read", scopes: ["aliases:read"] });
    const escalate = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/tokens",
      headers: { authorization: `Bearer ${read.secret}` },
      payload: { name: "escalate", scopes: ["aliases:write"] },
    });
    expect(escalate.statusCode).toBe(403);

    const listSessions = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: { authorization: `Bearer ${read.secret}` },
    });
    expect(listSessions.statusCode).toBe(403);
  });
});
