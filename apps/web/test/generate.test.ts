import { describe, expect, it } from "vitest";
import {
  buildCreateAliasRequest,
  defaultGenerateOptions,
  leaseForPreset,
  validateGenerateOptions,
  type GenerateOptions,
} from "../src/lib/generate.js";
import { NOW } from "./helpers.js";

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { ...defaultGenerateOptions(), label: "Example Store", ...overrides };
}

describe("leaseForPreset", () => {
  it("maps the duration presets", () => {
    expect(leaseForPreset("24h", "", NOW)).toEqual({ type: "duration", durationSeconds: 86400 });
    expect(leaseForPreset("7d", "", NOW)).toEqual({ type: "duration", durationSeconds: 604800 });
    expect(leaseForPreset("30d", "", NOW)).toEqual({ type: "duration", durationSeconds: 2592000 });
    expect(leaseForPreset("none", "", NOW)).toEqual({ type: "none" });
  });

  it("maps a custom preset to an absolute expiry", () => {
    const value = "2026-12-01T10:30";
    const lease = leaseForPreset("custom", value, NOW);
    expect(lease).toEqual({ type: "absolute", expiresAt: new Date(value).toISOString() });
  });

  it("rejects an invalid custom expiry", () => {
    expect(() => leaseForPreset("custom", "", NOW)).toThrow();
  });
});

describe("buildCreateAliasRequest", () => {
  it("never includes an address or local part", () => {
    const request = buildCreateAliasRequest(options(), NOW);
    expect(Object.keys(request)).not.toContain("address");
    expect(Object.keys(request)).not.toContain("localPart");
    expect(request.label).toBe("Example Store");
    expect(request.lease).toEqual({ type: "duration", durationSeconds: 604800 });
    expect(request.renewOnOutbound).toBe(true);
  });

  it("trims fields and nulls an empty purpose", () => {
    const request = buildCreateAliasRequest(options({ label: "  Store  ", purpose: "   " }), NOW);
    expect(request.label).toBe("Store");
    expect(request.purpose).toBeNull();
  });

  it("keeps a provided purpose", () => {
    const request = buildCreateAliasRequest(options({ purpose: "Order 42" }), NOW);
    expect(request.purpose).toBe("Order 42");
  });
});

describe("validateGenerateOptions", () => {
  it("requires a label", () => {
    expect(validateGenerateOptions(options({ label: "  " }), NOW)).toMatch(/label/i);
  });

  it("requires a future custom expiry", () => {
    const localInput = (ms: number): string => {
      const date = new Date(ms);
      const pad = (value: number): string => String(value).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
        date.getHours(),
      )}:${pad(date.getMinutes())}`;
    };
    const past = localInput(NOW - 60_000);
    expect(
      validateGenerateOptions(options({ preset: "custom", customExpiresAt: past }), NOW),
    ).toMatch(/future/i);
    const future = localInput(NOW + 60_000);
    expect(
      validateGenerateOptions(options({ preset: "custom", customExpiresAt: future }), NOW),
    ).toBeNull();
  });
});
