import { afterEach, describe, expect, it } from "vitest";
import { getAliasById } from "../src/alias/repository.js";
import type { SqliteDatabase } from "../src/db/database.js";
import {
  getProvenance,
  recordInboundAcceptance,
  recordProvenance,
} from "../src/provenance/repository.js";
import { createTestDatabase, DAY_MS, NOW } from "./helpers.js";
import { createTestAlias } from "./mail-helpers.js";

let db: SqliteDatabase;

afterEach(() => {
  db?.close();
});

const MESSAGE_ID = "018f0d9c-0000-7000-8000-000000000000";

describe("provenance", () => {
  it("records alias IDs, the primary flag, and the envelope including blind copies", () => {
    db = createTestDatabase();
    const first = createTestAlias(db, { address: "green.farm@example.com", expiresAt: null });
    const second = createTestAlias(db, { address: "blue.sky@example.com", expiresAt: null });

    const provenance = recordProvenance(db, {
      messageId: MESSAGE_ID,
      aliasIds: [first.id, second.id],
      primaryReceived: true,
      envelopeRecipients: [
        "green.farm@example.com",
        "blue.sky@example.com",
        "me@example.com",
        "green.farm@example.com",
      ],
      createdAt: NOW,
    });

    expect(provenance.primaryReceived).toBe(true);
    expect(provenance.envelopeRecipients).toHaveLength(3);
    expect(getProvenance(db, MESSAGE_ID)).toEqual(provenance);
  });
  it("is idempotent for the same message ID", () => {
    db = createTestDatabase();
    const alias = createTestAlias(db, { address: "green.farm@example.com", expiresAt: null });
    const input = {
      messageId: MESSAGE_ID,
      aliasIds: [alias.id],
      primaryReceived: false,
      envelopeRecipients: ["green.farm@example.com"],
      createdAt: NOW,
    };
    recordProvenance(db, input);
    recordProvenance(db, input);
    const rows = db.prepare("SELECT COUNT(*) AS count FROM message_provenance").get() as {
      count: number;
    };
    expect(rows.count).toBe(1);
  });
});

describe("recordInboundAcceptance", () => {
  it("updates last_inbound_at without changing expires_at or policy_version", () => {
    db = createTestDatabase();
    const alias = createTestAlias(db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
    });
    const before = getAliasById(db, alias.id)!;

    recordInboundAcceptance(db, {
      messageId: MESSAGE_ID,
      aliasIds: [alias.id],
      primaryReceived: false,
      envelopeRecipients: ["green.farm@example.com"],
      createdAt: NOW + 5000,
    });

    const after = getAliasById(db, alias.id)!;
    expect(after.lastInboundAt).toBe(NOW + 5000);
    expect(after.expiresAt).toBe(before.expiresAt);
    expect(after.policyVersion).toBe(before.policyVersion);
  });

  it("updates every receiving alias", () => {
    db = createTestDatabase();
    const first = createTestAlias(db, { address: "green.farm@example.com", expiresAt: null });
    const second = createTestAlias(db, { address: "blue.sky@example.com", expiresAt: null });

    recordInboundAcceptance(db, {
      messageId: MESSAGE_ID,
      aliasIds: [first.id, second.id],
      primaryReceived: true,
      envelopeRecipients: ["green.farm@example.com", "blue.sky@example.com"],
      createdAt: NOW,
    });

    expect(getAliasById(db, first.id)!.lastInboundAt).toBe(NOW);
    expect(getAliasById(db, second.id)!.lastInboundAt).toBe(NOW);
  });
});
