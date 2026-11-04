import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  apiScopeSchema,
  createApiTokenRequestSchema,
  listQuarantineQuerySchema,
  loginRequestSchema,
  setupRequestSchema,
} from "./index.js";

describe("apiScopeSchema", () => {
  it("accepts exactly the six documented scopes", () => {
    const scopes = [
      "aliases:read",
      "aliases:write",
      "quarantine:read",
      "quarantine:write",
      "messages:read",
      "messages:reply",
    ];
    for (const scope of scopes) {
      expect(apiScopeSchema.safeParse(scope).success).toBe(true);
    }
    expect(apiScopeSchema.safeParse("root").success).toBe(false);
  });
});

describe("authentication schemas", () => {
  it("requires a username and password on login", () => {
    expect(loginRequestSchema.safeParse({ username: "admin", password: "x" }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ username: "admin" }).success).toBe(false);
  });

  it("requires a setup token and a reasonably long password", () => {
    expect(setupRequestSchema.safeParse({ token: "wmksetup_x", password: "short" }).success).toBe(
      false,
    );
    expect(
      setupRequestSchema.safeParse({
        token: "wmksetup_x",
        password: "a long enough password",
      }).success,
    ).toBe(true);
  });

  it("requires at least one scope on a new API token", () => {
    expect(createApiTokenRequestSchema.safeParse({ name: "ci", scopes: [] }).success).toBe(false);
    expect(
      createApiTokenRequestSchema.safeParse({ name: "ci", scopes: ["aliases:read"] }).success,
    ).toBe(true);
  });
});

describe("quarantine and error schemas", () => {
  it("parses a list query and rejects unknown parameters", () => {
    expect(listQuarantineQuerySchema.safeParse({ status: "quarantined", limit: 10 }).success).toBe(
      true,
    );
    expect(listQuarantineQuerySchema.safeParse({ bogus: true }).success).toBe(false);
  });

  it("parses an API error body", () => {
    expect(
      apiErrorSchema.safeParse({ error: { code: "not_found", message: "missing" } }).success,
    ).toBe(true);
    expect(apiErrorSchema.safeParse({ message: "missing" }).success).toBe(false);
  });
});
