import { describe, expect, it } from "vitest";
import { effectiveState } from "../src/lease/state.js";

const NOW = 1_000_000;

describe("effectiveState", () => {
  it("is active when there is no expiry and no disablement", () => {
    expect(effectiveState({ expiresAt: null, disabledAt: null }, NOW)).toBe("active");
  });

  it("is active while the expiry is in the future", () => {
    expect(effectiveState({ expiresAt: NOW + 1, disabledAt: null }, NOW)).toBe("active");
  });

  it("is expired at the expiry instant", () => {
    expect(effectiveState({ expiresAt: NOW, disabledAt: null }, NOW)).toBe("expired");
  });

  it("is expired after the expiry instant", () => {
    expect(effectiveState({ expiresAt: NOW - 1, disabledAt: null }, NOW)).toBe("expired");
  });

  it("prefers disabled over expired", () => {
    expect(effectiveState({ expiresAt: NOW - 1, disabledAt: NOW - 100 }, NOW)).toBe("disabled");
  });

  it("prefers disabled over active", () => {
    expect(effectiveState({ expiresAt: NOW + 1, disabledAt: NOW - 100 }, NOW)).toBe("disabled");
  });
});
