import { afterEach, describe, expect, it } from "vitest";
import {
  aliasAddressExists,
  AliasNotFoundError,
  createAlias,
  createAliasWithGeneratedAddress,
  findAliasByAddress,
  getAliasById,
  PolicyVersionConflictError,
  requireAlias,
  updateAlias,
} from "../src/alias/repository.js";
import type { SqliteDatabase } from "../src/db/database.js";
import { createTestDatabase, DAY_MS, NOW, TEST_DOMAIN } from "./helpers.js";

let db: SqliteDatabase;

afterEach(() => {
  db?.close();
});

function open(): SqliteDatabase {
  db = createTestDatabase();
  return db;
}

describe("createAlias", () => {
  it("stores a canonical address and lease policy", () => {
    open();
    const alias = createAlias(db, {
      address: "Green.Farm@Example.COM",
      label: "Example Store",
      purpose: "order 123",
      createdAt: NOW,
      expiresAt: NOW + DAY_MS,
      leaseDurationSeconds: 3600,
      renewOnOutbound: true,
    });
    expect(alias.address).toBe("green.farm@example.com");
    expect(alias.localPart).toBe("green.farm");
    expect(alias.domain).toBe("example.com");
    expect(alias.leaseDurationSeconds).toBe(3600);
    expect(alias.renewOnOutbound).toBe(true);
    expect(alias.policyVersion).toBe(0);
    expect(getAliasById(db, alias.id)).toEqual(alias);
  });

  it("rejects a duplicate canonical address", () => {
    open();
    createAlias(db, {
      address: "green.farm@example.com",
      label: "first",
      createdAt: NOW,
      expiresAt: null,
      leaseDurationSeconds: 3600,
      renewOnOutbound: true,
    });
    expect(() =>
      createAlias(db, {
        address: "GREEN.FARM@EXAMPLE.COM",
        label: "second",
        createdAt: NOW,
        expiresAt: null,
        leaseDurationSeconds: 3600,
        renewOnOutbound: true,
      }),
    ).toThrow(/UNIQUE/);
  });
});

describe("lookup", () => {
  it("finds an alias case-insensitively", () => {
    open();
    const alias = createAlias(db, {
      address: "green.farm@example.com",
      label: "Example Store",
      createdAt: NOW,
      expiresAt: null,
      leaseDurationSeconds: 3600,
      renewOnOutbound: true,
    });
    expect(findAliasByAddress(db, "GREEN.FARM@EXAMPLE.COM")?.id).toBe(alias.id);
    expect(aliasAddressExists(db, "Green.Farm@Example.Com")).toBe(true);
  });

  it("matches an IDN domain to its punycode form", () => {
    open();
    createAlias(db, {
      address: "green.farm@münchen.example",
      label: "IDN",
      createdAt: NOW,
      expiresAt: null,
      leaseDurationSeconds: 3600,
      renewOnOutbound: true,
    });
    expect(findAliasByAddress(db, "green.farm@MÜNCHEN.EXAMPLE")?.address).toBe(
      "green.farm@xn--mnchen-3ya.example",
    );
  });

  it("does not match plus addressing", () => {
    open();
    createAlias(db, {
      address: "green.farm@example.com",
      label: "Example Store",
      createdAt: NOW,
      expiresAt: null,
      leaseDurationSeconds: 3600,
      renewOnOutbound: true,
    });
    expect(findAliasByAddress(db, "green.farm+tag@example.com")).toBeUndefined();
    expect(findAliasByAddress(db, "other@example.com")).toBeUndefined();
    expect(findAliasByAddress(db, "not-an-address")).toBeUndefined();
  });

  it("throws when an alias does not exist", () => {
    open();
    expect(() => requireAlias(db, "00000000-0000-4000-8000-000000000000")).toThrow(
      AliasNotFoundError,
    );
  });
});

describe("createAliasWithGeneratedAddress", () => {
  it("generates and stores a readable unique address", () => {
    open();
    const alias = createAliasWithGeneratedAddress(db, {
      domain: TEST_DOMAIN,
      label: "Example Store",
      createdAt: NOW,
      expiresAt: NOW + DAY_MS,
      leaseDurationSeconds: 604800,
      renewOnOutbound: true,
    });
    expect(alias.address).toMatch(/^[a-z]+\.[a-z]+@example\.com$/);
    expect(aliasAddressExists(db, alias.address)).toBe(true);
  });

  it("retries against stored addresses on collision", () => {
    open();
    const generator = {
      wordList: ["alpha", "beta"] as const,
      randomIndex: () => 0,
    };
    createAlias(db, {
      address: "alpha.alpha@example.com",
      label: "existing",
      createdAt: NOW,
      expiresAt: null,
      leaseDurationSeconds: 3600,
      renewOnOutbound: true,
    });
    const generated = createAliasWithGeneratedAddress(db, {
      domain: TEST_DOMAIN,
      label: "collision",
      createdAt: NOW,
      expiresAt: null,
      leaseDurationSeconds: 3600,
      renewOnOutbound: true,
      generator: { wordList: generator.wordList, randomIndex: generator.randomIndex },
    });
    expect(generated.address).not.toBe("alpha.alpha@example.com");
    expect(generated.localPart.split(".").length).toBeGreaterThan(2);
  });

  it("generates a different address on a second call", () => {
    open();
    const first = createAliasWithGeneratedAddress(db, {
      domain: TEST_DOMAIN,
      label: "one",
      createdAt: NOW,
      expiresAt: null,
      leaseDurationSeconds: 3600,
      renewOnOutbound: true,
    });
    const second = createAliasWithGeneratedAddress(db, {
      domain: TEST_DOMAIN,
      label: "two",
      createdAt: NOW,
      expiresAt: null,
      leaseDurationSeconds: 3600,
      renewOnOutbound: true,
    });
    expect(second.address).not.toBe(first.address);
  });
});

describe("updateAlias", () => {
  it("never changes the address when policy changes", () => {
    open();
    const alias = createAlias(db, {
      address: "green.farm@example.com",
      label: "Example Store",
      createdAt: NOW,
      expiresAt: NOW + DAY_MS,
      leaseDurationSeconds: 3600,
      renewOnOutbound: true,
    });
    const updated = updateAlias(db, alias.id, {
      expiresAt: NOW + 2 * DAY_MS,
      leaseDurationSeconds: 7200,
      renewOnOutbound: false,
    });
    expect(updated.address).toBe(alias.address);
    expect(updated.expiresAt).toBe(NOW + 2 * DAY_MS);
    expect(updated.leaseDurationSeconds).toBe(7200);
    expect(updated.renewOnOutbound).toBe(false);
    expect(updated.policyVersion).toBe(1);
  });

  it("enforces optimistic concurrency on policy version", () => {
    open();
    const alias = createAlias(db, {
      address: "green.farm@example.com",
      label: "Example Store",
      createdAt: NOW,
      expiresAt: null,
      leaseDurationSeconds: 3600,
      renewOnOutbound: true,
    });
    updateAlias(db, alias.id, { label: "renamed" }, { expectedPolicyVersion: 0 });
    expect(() =>
      updateAlias(db, alias.id, { label: "stale" }, { expectedPolicyVersion: 0 }),
    ).toThrow(PolicyVersionConflictError);
  });

  it("records last user activity and disablement", () => {
    open();
    const alias = createAlias(db, {
      address: "green.farm@example.com",
      label: "Example Store",
      createdAt: NOW,
      expiresAt: null,
      leaseDurationSeconds: 3600,
      renewOnOutbound: true,
    });
    const touched = updateAlias(db, alias.id, {
      lastUserActivityAt: NOW + 10,
      lastInboundAt: NOW + 5,
    });
    expect(touched.lastUserActivityAt).toBe(NOW + 10);
    expect(touched.lastInboundAt).toBe(NOW + 5);

    const disabled = updateAlias(db, alias.id, { disabledAt: NOW + 20 });
    expect(disabled.disabledAt).toBe(NOW + 20);
    const enabled = updateAlias(db, alias.id, { disabledAt: null });
    expect(enabled.disabledAt).toBeNull();
  });
});
