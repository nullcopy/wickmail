import { afterEach, describe, expect, it } from "vitest";
import type { SqliteDatabase } from "../src/db/database.js";
import { createRecipientPolicy } from "../src/policy/recipient.js";
import { createTestDatabase, DAY_MS, NOW, TEST_DOMAIN } from "./helpers.js";
import { createTestAlias } from "./mail-helpers.js";

let db: SqliteDatabase;

afterEach(() => {
  db?.close();
});

function policy() {
  db = createTestDatabase();
  return createRecipientPolicy({
    db,
    localDomains: [TEST_DOMAIN],
    primaryAddresses: ["me@example.com"],
  });
}

describe("recipient policy", () => {
  it("accepts an active alias", () => {
    const subject = policy();
    const alias = createTestAlias(db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
    });
    expect(subject.evaluate("green.farm@example.com", NOW)).toEqual({
      outcome: "accept",
      recipient: "alias",
      aliasId: alias.id,
      state: "active",
    });
  });

  it("accepts an expired alias and reports its state", () => {
    const subject = policy();
    createTestAlias(db, { address: "green.farm@example.com", expiresAt: NOW - DAY_MS });
    expect(subject.evaluate("green.farm@example.com", NOW)).toMatchObject({
      outcome: "accept",
      recipient: "alias",
      state: "expired",
    });
  });

  it("rejects a disabled alias", () => {
    const subject = policy();
    createTestAlias(db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
      disabledAt: NOW - 1,
    });
    expect(subject.evaluate("green.farm@example.com", NOW)).toEqual({
      outcome: "reject",
      reason: "disabled",
    });
  });

  it("rejects an unknown recipient", () => {
    const subject = policy();
    expect(subject.evaluate("nobody@example.com", NOW)).toEqual({
      outcome: "reject",
      reason: "unknown",
    });
  });

  it("rejects a recipient outside the local domains", () => {
    const subject = policy();
    expect(subject.evaluate("green.farm@elsewhere.test", NOW)).toEqual({
      outcome: "reject",
      reason: "unknown",
    });
  });

  it("rejects a malformed address", () => {
    const subject = policy();
    expect(subject.evaluate("not-an-address", NOW)).toEqual({
      outcome: "reject",
      reason: "unknown",
    });
  });

  it("accepts a primary address", () => {
    const subject = policy();
    expect(subject.evaluate("me@example.com", NOW)).toEqual({
      outcome: "accept",
      recipient: "primary",
    });
  });

  it("looks up the canonical address case-insensitively", () => {
    const subject = policy();
    const alias = createTestAlias(db, { address: "green.farm@example.com", expiresAt: null });
    expect(subject.evaluate("GREEN.FARM@EXAMPLE.COM", NOW)).toMatchObject({
      outcome: "accept",
      recipient: "alias",
      aliasId: alias.id,
    });
    expect(subject.evaluate("ME@Example.Com", NOW)).toEqual({
      outcome: "accept",
      recipient: "primary",
    });
  });

  it("returns a temporary failure, never an unknown recipient, on an internal error", () => {
    db = createTestDatabase();
    const subject = createRecipientPolicy({
      db,
      localDomains: [TEST_DOMAIN],
      lookupAlias: () => {
        throw new Error("database is locked");
      },
    });
    expect(subject.evaluate("green.farm@example.com", NOW)).toEqual({
      outcome: "tempfail",
      reason: "database is locked",
    });
  });

  it("does not permanently reject an expired alias whose expiry is exactly now", () => {
    const subject = policy();
    createTestAlias(db, { address: "green.farm@example.com", expiresAt: NOW });
    expect(subject.evaluate("green.farm@example.com", NOW)).toMatchObject({
      outcome: "accept",
      state: "expired",
    });
  });
});
