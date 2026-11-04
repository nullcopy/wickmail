import { describe, expect, it, vi } from "vitest";
import { ApiClientError, createApiClient, type FetchLike } from "./client.js";

const validAlias = {
  id: "00000000-0000-4000-8000-000000000000",
  address: "green.farm@example.com",
  label: "Example Store",
  purpose: null,
  state: "active",
  lease: { leaseDurationSeconds: 604800, renewOnOutbound: true },
  createdAt: "2026-11-03T00:00:00.000Z",
  expiresAt: "2026-11-10T00:00:00.000Z",
  disabledAt: null,
  lastInboundAt: null,
  lastUserActivityAt: null,
  policyVersion: 0,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createApiClient", () => {
  it("sends same-origin credentialed requests with the CSRF token on mutations", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      jsonResponse({
        user: {
          id: "00000000-0000-4000-8000-0000000000aa",
          username: "admin",
          createdAt: "2026-11-03T00:00:00.000Z",
          updatedAt: "2026-11-03T00:00:00.000Z",
          hasPassword: true,
          passkeyCount: 0,
        },
        session: {
          id: "00000000-0000-4000-8000-0000000000bb",
          createdAt: "2026-11-03T00:00:00.000Z",
          expiresAt: "2026-12-03T00:00:00.000Z",
          lastUsedAt: null,
          userAgent: null,
          current: true,
        },
        csrfToken: "csrf",
      }),
    );
    const client = createApiClient({ fetch, getCsrfToken: () => "csrf-token" });
    await client.login({ username: "admin", password: "secret" });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/v1/auth/login");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect((init?.headers as Record<string, string>)["X-CSRF-Token"]).toBe("csrf-token");
    expect(JSON.parse(String(init?.body))).toEqual({ username: "admin", password: "secret" });
  });

  it("serializes query parameters, including booleans", async () => {
    const fetch = vi.fn<FetchLike>(async () => jsonResponse({ aliases: [], nextCursor: null }));
    const client = createApiClient({ fetch });
    await client.listAliases({ state: "active", hasExpiry: false, sort: "expires", order: "asc" });

    const [url] = fetch.mock.calls[0]!;
    expect(url).toContain("/v1/aliases?");
    expect(url).toContain("state=active");
    expect(url).toContain("hasExpiry=false");
    expect(url).toContain("sort=expires");
    expect(url).toContain("order=asc");
  });

  it("validates responses against the shared schemas", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      jsonResponse({ alias: { ...validAlias, state: "weird" } }),
    );
    const client = createApiClient({ fetch });
    await expect(client.getAlias(validAlias.id)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("maps error bodies to ApiClientError", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      jsonResponse({ error: { code: "conflict", message: "alias changed" } }, 409),
    );
    const client = createApiClient({ fetch });
    const error = await client
      .updateAlias(validAlias.id, { label: "x", policyVersion: 1 })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ status: 409, code: "conflict", message: "alias changed" });
  });

  it("reports a transport failure as a network error", async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      throw new TypeError("failed to fetch");
    });
    const client = createApiClient({ fetch });
    const error = await client.getSession().catch((reason: unknown) => reason);
    expect(error).toMatchObject({ status: 0, code: "network_error" });
  });

  it("returns null for an unauthenticated session", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      jsonResponse({ error: { code: "unauthorized", message: "" } }, 401),
    );
    const client = createApiClient({ fetch });
    await expect(client.getSession()).resolves.toBeNull();
  });
});
