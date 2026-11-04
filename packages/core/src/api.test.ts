import { describe, expect, it } from "vitest";
import {
  aliasResponseValidator,
  aliasSchema,
  createAliasRequestValidator,
  listAliasesQueryValidator,
  updateAliasRequestValidator,
} from "./index.js";

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

describe("createAliasRequestSchema", () => {
  it("accepts a label with a duration lease", () => {
    const result = createAliasRequestValidator.safeParse({
      label: "Example Store",
      lease: { type: "duration", durationSeconds: 3600 },
      renewOnOutbound: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts every lease variant", () => {
    for (const lease of [
      { type: "duration", durationSeconds: 60 },
      { type: "absolute", expiresAt: "2026-11-10T00:00:00.000Z" },
      { type: "none" },
    ]) {
      expect(createAliasRequestValidator.safeParse({ label: "x", lease }).success).toBe(true);
    }
  });

  it("rejects a client-supplied address or local part", () => {
    expect(
      createAliasRequestValidator.safeParse({ label: "x", address: "green.farm@example.com" })
        .success,
    ).toBe(false);
    expect(
      createAliasRequestValidator.safeParse({ label: "x", localPart: "green.farm" }).success,
    ).toBe(false);
  });

  it("rejects an unknown lease type and an empty label", () => {
    expect(
      createAliasRequestValidator.safeParse({ label: "x", lease: { type: "forever" } }).success,
    ).toBe(false);
    expect(createAliasRequestValidator.safeParse({ label: "" }).success).toBe(false);
  });
});

describe("aliasSchema", () => {
  it("parses a canonical alias", () => {
    expect(aliasSchema.safeParse(validAlias).success).toBe(true);
  });

  it("rejects an unknown effective state", () => {
    expect(aliasSchema.safeParse({ ...validAlias, state: "renewed" }).success).toBe(false);
  });

  it("requires a UTC timestamp", () => {
    expect(
      aliasSchema.safeParse({ ...validAlias, createdAt: "2026-11-03T00:00:00+02:00" }).success,
    ).toBe(false);
  });
});

describe("management API validators", () => {
  it("parses an alias response", () => {
    expect(aliasResponseValidator.safeParse({ alias: validAlias }).success).toBe(true);
  });

  it("parses a list query and rejects unknown parameters", () => {
    expect(listAliasesQueryValidator.safeParse({ state: "active", sort: "lastUsed" }).success).toBe(
      true,
    );
    expect(listAliasesQueryValidator.safeParse({ bogus: true }).success).toBe(false);
  });

  it("requires policyVersion on update", () => {
    expect(updateAliasRequestValidator.safeParse({ label: "x" }).success).toBe(false);
    expect(updateAliasRequestValidator.safeParse({ label: "x", policyVersion: 1 }).success).toBe(
      true,
    );
  });
});
