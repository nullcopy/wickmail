import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqliteDatabase } from "../src/db/database.js";
import { FakeMailStore } from "../src/mailstore/fake.js";
import { QuarantineReconciler } from "../src/quarantine/reconciliation.js";
import { requireQuarantineEntry, updateQuarantineStatus } from "../src/quarantine/repository.js";
import { QuarantineService } from "../src/quarantine/service.js";
import {
  defaultQuarantineRetentionPolicy,
  INBOX_MAILBOX,
  QUARANTINE_MAILBOX,
} from "../src/quarantine/types.js";
import { createTestDatabase, NOW } from "./helpers.js";
import {
  copiesOf,
  quarantineRaw,
  seedAliases,
  seedQuarantinedMessage,
} from "./quarantine-helpers.js";

function reconciler(db: SqliteDatabase, store: FakeMailStore): QuarantineReconciler {
  return new QuarantineReconciler({ db, store, policy: defaultQuarantineRetentionPolicy() });
}

function service(db: SqliteDatabase, store: FakeMailStore): QuarantineService {
  return new QuarantineService({ db, store, now: () => NOW });
}

describe("quarantine reconciliation", () => {
  it("keeps the inbox copy and removes the quarantine copy when both exist", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    store.put(INBOX_MAILBOX, "m1", quarantineRaw({ messageId: "m1" }), NOW);

    const report = await reconciler(db, store).runOnce();
    expect(report.recovered).toBe(1);
    expect(requireQuarantineEntry(db, "m1").status).toBe("recovered");
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "m1")).toBeUndefined();
    expect(await copiesOf(store, "m1")).toBe(1);
    db.close();
  });

  it("returns a recovering message to quarantined when the inbox copy is missing", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    updateQuarantineStatus(db, "m1", "recovering", { operationKey: "k1", now: NOW });

    const report = await reconciler(db, store).runOnce();
    expect(report.requarantined).toBe(1);
    expect(requireQuarantineEntry(db, "m1").status).toBe("quarantined");
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "m1")).toBeDefined();
    db.close();
  });

  it("leaves a quarantined message in quarantine when only the quarantine copy remains", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });

    const report = await reconciler(db, store).runOnce();
    expect(report).toMatchObject({ requarantined: 0, recovered: 0, deleted: 0 });
    expect(requireQuarantineEntry(db, "m1").status).toBe("quarantined");
    db.close();
  });

  it("marks metadata deleted when neither copy exists", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    await store.deleteMessage(QUARANTINE_MAILBOX, "m1");

    const report = await reconciler(db, store).runOnce();
    expect(report.deleted).toBe(1);
    expect(requireQuarantineEntry(db, "m1").status).toBe("deleted");
    db.close();
  });

  it("marks metadata recovered when only the inbox copy exists", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    await store.deleteMessage(QUARANTINE_MAILBOX, "m1");
    store.put(INBOX_MAILBOX, "m1", quarantineRaw({ messageId: "m1" }), NOW);

    const report = await reconciler(db, store).runOnce();
    expect(report.recovered).toBe(1);
    expect(requireQuarantineEntry(db, "m1").status).toBe("recovered");
    db.close();
  });

  it("finishes a deletion that crashed after marking deleting", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    updateQuarantineStatus(db, "m1", "deleting", { operationKey: "user_requested", now: NOW });

    const report = await reconciler(db, store).runOnce();
    expect(report.deleted).toBe(1);
    expect(requireQuarantineEntry(db, "m1").status).toBe("deleted");
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "m1")).toBeUndefined();
    db.close();
  });

  it("marks a deleting message deleted when its body is already gone", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    updateQuarantineStatus(db, "m1", "deleting", { operationKey: "retention_expired", now: NOW });
    await store.deleteMessage(QUARANTINE_MAILBOX, "m1");

    const report = await reconciler(db, store).runOnce();
    expect(report.deleted).toBe(1);
    expect(requireQuarantineEntry(db, "m1").status).toBe("deleted");
    db.close();
  });

  it("removes a leftover quarantine copy of a recovered message", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    await store.copyMessage("m1", INBOX_MAILBOX);
    updateQuarantineStatus(db, "m1", "recovered", { now: NOW });

    await reconciler(db, store).runOnce();
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "m1")).toBeUndefined();
    expect(await copiesOf(store, "m1")).toBe(1);
    db.close();
  });

  it("rebuilds metadata for a quarantine message with none", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    const [aliasId] = seedAliases(db, 1);
    store.put(
      QUARANTINE_MAILBOX,
      "m1",
      quarantineRaw({ messageId: "m1", aliasIds: [aliasId!] }),
      NOW,
    );

    const report = await reconciler(db, store).runOnce();
    expect(report.rebuilt).toBe(1);
    const entry = requireQuarantineEntry(db, "m1");
    expect(entry.aliasIds).toEqual([aliasId]);
    expect(entry.status).toBe("quarantined");
    db.close();
  });

  it("repairs state before a destructive operation", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    // Simulate a crash between copy and delete.
    await store.copyMessage("m1", INBOX_MAILBOX);
    updateQuarantineStatus(db, "m1", "recovering", { operationKey: "k1", now: NOW });

    const outcome = await service(db, store).recover("m1");
    expect(outcome).toEqual({ status: "already_recovered", messageId: "m1" });
    expect(requireQuarantineEntry(db, "m1").status).toBe("recovered");
    expect(await copiesOf(store, "m1")).toBe(1);
    db.close();
  });
});

describe("periodic reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconciles at startup and on an interval", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    store.put(QUARANTINE_MAILBOX, "m1", quarantineRaw({ messageId: "m1" }), NOW);
    const quarantine = service(db, store);

    quarantine.start(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(requireQuarantineEntry(db, "m1").status).toBe("quarantined");

    store.put(QUARANTINE_MAILBOX, "m2", quarantineRaw({ messageId: "m2" }), NOW);
    await vi.advanceTimersByTimeAsync(1000);
    expect(requireQuarantineEntry(db, "m2").status).toBe("quarantined");

    quarantine.stop();
    db.close();
  });
});
