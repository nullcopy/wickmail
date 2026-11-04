import { afterEach, describe, expect, it } from "vitest";
import { getAliasById } from "../src/alias/repository.js";
import type { SqliteDatabase } from "../src/db/database.js";
import { composeReply } from "../src/reply/outbound.js";
import {
  MemoryOutboundQueue,
  type NewOutboundMessage,
  type OutboundQueue,
} from "../src/reply/queue.js";
import { submitOutbound } from "../src/reply/submission.js";
import { createTestDatabase, DAY_MS, NOW } from "./helpers.js";
import { createTestAlias } from "./mail-helpers.js";

let db: SqliteDatabase;

afterEach(() => {
  db?.close();
});

const LEASE_SECONDS = 3600;
const PRIMARY = "me@example.com";

function aliasReply(aliasId: string, address: string): string {
  return composeReply({
    identity: { kind: "alias", aliasId, address },
    to: "sender@example.net",
    subject: "Hi",
    body: "body",
    now: NOW,
    messageId: "<reply@example.com>",
  });
}

function primaryReply(address: string): string {
  return composeReply({
    identity: { kind: "primary", address },
    to: "sender@example.net",
    subject: "Hi",
    body: "body",
    now: NOW,
    messageId: "<reply@example.com>",
  });
}

describe("submitOutbound renewal", () => {
  it("renews an active alias when renew_on_outbound is true", async () => {
    db = createTestDatabase();
    const queue = new MemoryOutboundQueue();
    const alias = createTestAlias(db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
      leaseDurationSeconds: LEASE_SECONDS,
      renewOnOutbound: true,
    });

    const result = await submitOutbound(
      { db, queue, primaryAddresses: [PRIMARY] },
      {
        identity: { kind: "alias", aliasId: alias.id, address: alias.address },
        raw: aliasReply(alias.id, alias.address),
        recipients: ["sender@example.net"],
        now: NOW,
      },
    );

    expect(result).toMatchObject({ status: "queued", renewed: true });
    expect(result.status === "queued" && result.expiresAt).toBe(NOW + LEASE_SECONDS * 1000);
    expect(getAliasById(db, alias.id)!.expiresAt).toBe(NOW + LEASE_SECONDS * 1000);
    expect(await queue.list()).toHaveLength(1);
  });

  it("accepts without renewing an active alias when renew_on_outbound is false", async () => {
    db = createTestDatabase();
    const queue = new MemoryOutboundQueue();
    const expiresAt = NOW + DAY_MS;
    const alias = createTestAlias(db, {
      address: "green.farm@example.com",
      expiresAt,
      renewOnOutbound: false,
    });

    const result = await submitOutbound(
      { db, queue },
      {
        identity: { kind: "alias", aliasId: alias.id, address: alias.address },
        raw: aliasReply(alias.id, alias.address),
        recipients: ["sender@example.net"],
        now: NOW,
      },
    );

    expect(result).toMatchObject({ status: "queued", renewed: false, expiresAt });
    const stored = getAliasById(db, alias.id)!;
    expect(stored.expiresAt).toBe(expiresAt);
    expect(stored.lastUserActivityAt).toBe(NOW);
  });

  it("reactivates an expired alias when renew_on_outbound is true", async () => {
    db = createTestDatabase();
    const queue = new MemoryOutboundQueue();
    const alias = createTestAlias(db, {
      address: "green.farm@example.com",
      expiresAt: NOW - DAY_MS,
      leaseDurationSeconds: LEASE_SECONDS,
      renewOnOutbound: true,
    });

    const result = await submitOutbound(
      { db, queue },
      {
        identity: { kind: "alias", aliasId: alias.id, address: alias.address },
        raw: aliasReply(alias.id, alias.address),
        recipients: ["sender@example.net"],
        now: NOW,
      },
    );

    expect(result).toMatchObject({ status: "queued", renewed: true });
    expect(getAliasById(db, alias.id)!.expiresAt).toBe(NOW + LEASE_SECONDS * 1000);
  });

  it("rejects an expired alias when renew_on_outbound is false", async () => {
    db = createTestDatabase();
    const queue = new MemoryOutboundQueue();
    const expiresAt = NOW - DAY_MS;
    const alias = createTestAlias(db, {
      address: "green.farm@example.com",
      expiresAt,
      renewOnOutbound: false,
    });

    const result = await submitOutbound(
      { db, queue },
      {
        identity: { kind: "alias", aliasId: alias.id, address: alias.address },
        raw: aliasReply(alias.id, alias.address),
        recipients: ["sender@example.net"],
        now: NOW,
      },
    );

    expect(result).toEqual({
      status: "rejected",
      reason: "alias is expired and does not renew on outbound",
    });
    expect(await queue.list()).toHaveLength(0);
    expect(getAliasById(db, alias.id)!.expiresAt).toBe(expiresAt);
  });

  it("rejects a disabled alias", async () => {
    db = createTestDatabase();
    const queue = new MemoryOutboundQueue();
    const alias = createTestAlias(db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
      disabledAt: NOW - 1,
    });

    const result = await submitOutbound(
      { db, queue },
      {
        identity: { kind: "alias", aliasId: alias.id, address: alias.address },
        raw: aliasReply(alias.id, alias.address),
        recipients: ["sender@example.net"],
        now: NOW,
      },
    );

    expect(result).toMatchObject({ status: "rejected" });
    expect(await queue.list()).toHaveLength(0);
  });
});

describe("submitOutbound renewal timing", () => {
  it("renews only after the message is accepted and queued", async () => {
    db = createTestDatabase();
    const alias = createTestAlias(db, {
      address: "green.farm@example.com",
      expiresAt: NOW - DAY_MS,
      leaseDurationSeconds: LEASE_SECONDS,
      renewOnOutbound: true,
    });

    let expiresAtDuringEnqueue: number | null | undefined;
    const inner = new MemoryOutboundQueue();
    const queue: OutboundQueue = {
      enqueue: async (message: NewOutboundMessage) => {
        // The pre-queue checks must not have renewed the alias yet.
        expiresAtDuringEnqueue = getAliasById(db, alias.id)!.expiresAt;
        await inner.enqueue(message);
      },
      list: () => inner.list(),
      get: (id) => inner.get(id),
      remove: (id) => inner.remove(id),
      recordAttempt: (id, error, next) => inner.recordAttempt(id, error, next),
    };

    await submitOutbound(
      { db, queue },
      {
        identity: { kind: "alias", aliasId: alias.id, address: alias.address },
        raw: aliasReply(alias.id, alias.address),
        recipients: ["sender@example.net"],
        now: NOW,
      },
    );

    expect(expiresAtDuringEnqueue).toBe(NOW - DAY_MS);
    expect(getAliasById(db, alias.id)!.expiresAt).toBe(NOW + LEASE_SECONDS * 1000);
  });

  it("does not renew when the queue rejects the message", async () => {
    db = createTestDatabase();
    const expiresAt = NOW - DAY_MS;
    const alias = createTestAlias(db, {
      address: "green.farm@example.com",
      expiresAt,
      leaseDurationSeconds: LEASE_SECONDS,
      renewOnOutbound: true,
    });
    const queue: OutboundQueue = {
      enqueue: async () => {
        throw new Error("queue down");
      },
      list: async () => [],
      get: async () => undefined,
      remove: async () => {},
      recordAttempt: async () => {},
    };

    const result = await submitOutbound(
      { db, queue },
      {
        identity: { kind: "alias", aliasId: alias.id, address: alias.address },
        raw: aliasReply(alias.id, alias.address),
        recipients: ["sender@example.net"],
        now: NOW,
      },
    );

    expect(result).toMatchObject({ status: "tempfail" });
    expect(getAliasById(db, alias.id)!.expiresAt).toBe(expiresAt);
  });

  it("keeps the renewal after a later bounce", async () => {
    db = createTestDatabase();
    const queue = new MemoryOutboundQueue();
    const alias = createTestAlias(db, {
      address: "green.farm@example.com",
      expiresAt: NOW - DAY_MS,
      leaseDurationSeconds: LEASE_SECONDS,
      renewOnOutbound: true,
    });

    const result = await submitOutbound(
      { db, queue },
      {
        identity: { kind: "alias", aliasId: alias.id, address: alias.address },
        raw: aliasReply(alias.id, alias.address),
        recipients: ["sender@example.net"],
        now: NOW,
      },
    );
    expect(result.status).toBe("queued");
    if (result.status !== "queued") return;

    await queue.recordAttempt(result.messageId, "550 bounce", NOW + 60_000);
    expect(getAliasById(db, alias.id)!.expiresAt).toBe(NOW + LEASE_SECONDS * 1000);
  });
});

describe("submitOutbound identity enforcement", () => {
  it("rejects a message failing identity checks before it is queued", async () => {
    db = createTestDatabase();
    const queue = new MemoryOutboundQueue();
    const alias = createTestAlias(db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
    });
    const raw = ["From: other@example.net", "To: sender@example.net", "", "body"].join("\r\n");

    const result = await submitOutbound(
      { db, queue, primaryAddresses: [PRIMARY] },
      {
        identity: { kind: "alias", aliasId: alias.id, address: alias.address },
        raw,
        recipients: ["sender@example.net"],
        now: NOW,
      },
    );

    expect(result).toMatchObject({ status: "rejected" });
    expect(await queue.list()).toHaveLength(0);
  });

  it("rejects a submission for an unknown alias", async () => {
    db = createTestDatabase();
    const queue = new MemoryOutboundQueue();
    const result = await submitOutbound(
      { db, queue },
      {
        identity: {
          kind: "alias",
          aliasId: "018f0d9c-0000-7000-8000-00000000dead",
          address: "missing@example.com",
        },
        raw: primaryReply("missing@example.com"),
        recipients: ["sender@example.net"],
        now: NOW,
      },
    );
    expect(result).toEqual({ status: "rejected", reason: "alias not found" });
  });

  it("queues a primary-identity reply without renewing an alias", async () => {
    db = createTestDatabase();
    const queue = new MemoryOutboundQueue();

    const result = await submitOutbound(
      { db, queue, primaryAddresses: [PRIMARY] },
      {
        identity: { kind: "primary", address: PRIMARY },
        raw: primaryReply(PRIMARY),
        recipients: ["sender@example.net"],
        now: NOW,
      },
    );

    expect(result).toMatchObject({ status: "queued", renewed: false, expiresAt: null });
    const queued = await queue.list();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.aliasId).toBeNull();
    expect(queued[0]!.envelopeSender).toBe(PRIMARY);
  });
});
