import { describe, expect, it } from "vitest";
import {
  CanonicalizationError,
  canonicalizeAddress,
  canonicalizeDomain,
  canonicalizeLocalPart,
  splitCanonicalAddress,
} from "../src/alias/canonical.js";

describe("canonicalizeLocalPart", () => {
  it("lowercases and trims", () => {
    expect(canonicalizeLocalPart("  Green.Farm ")).toBe("green.farm");
  });

  it("preserves plus addressing instead of stripping it", () => {
    expect(canonicalizeLocalPart("green.farm+tag")).toBe("green.farm+tag");
  });

  it("rejects an empty local part", () => {
    expect(() => canonicalizeLocalPart("   ")).toThrow(CanonicalizationError);
  });

  it("rejects a non-ASCII local part", () => {
    expect(() => canonicalizeLocalPart("grün")).toThrow(CanonicalizationError);
  });
});

describe("canonicalizeDomain", () => {
  it("lowercases and drops a single trailing dot", () => {
    expect(canonicalizeDomain("Example.COM.")).toBe("example.com");
  });

  it("converts an IDN domain to punycode", () => {
    expect(canonicalizeDomain("München.Example")).toBe("xn--mnchen-3ya.example");
  });

  it("rejects an empty domain", () => {
    expect(() => canonicalizeDomain("")).toThrow(CanonicalizationError);
  });
});

describe("canonicalizeAddress", () => {
  it("canonicalizes both sides", () => {
    expect(canonicalizeAddress("Green.Farm@Example.COM")).toBe("green.farm@example.com");
  });

  it("rejects an address without exactly one local part and domain", () => {
    expect(() => canonicalizeAddress("green.farm")).toThrow(CanonicalizationError);
    expect(() => canonicalizeAddress("@example.com")).toThrow(CanonicalizationError);
    expect(() => canonicalizeAddress("green.farm@")).toThrow(CanonicalizationError);
  });

  it("splits a canonical address", () => {
    expect(splitCanonicalAddress("green.farm@example.com")).toEqual({
      localPart: "green.farm",
      domain: "example.com",
    });
  });
});
