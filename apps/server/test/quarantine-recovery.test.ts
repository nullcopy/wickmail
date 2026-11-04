import { describe, expect, it } from "vitest";
import { FakeMailStore } from "../src/mailstore/fake.js";
import { requireQuarantineEntry, updateQuarantineStatus } from "../src/quarantine/repository.js";
import { QuarantineService } from "../src/quarantine/service.js";
import type { FaultInjector, QuarantineFaultPoint } from "../src/quarantine/types.js";
import { INBOX_MAILBOX, QUARANTINE_MAILBOX } from "../src/quarantine/types.js";
import type { SqliteDatabase } from "../src/db/database.js";
import { createTestDatabase, NOW } from "./helpers.js";
import { copiesOf, seedQuarantinedMessage } from "./quarantine-helpers.js";

function crashAt(point: QuarantineFaultPoint): FaultInjector {
  let fired = false;
  return (at) => {
    if (!fired && at === point) {
      fired = true;
      throw new Error(`crash at ${at}`);
    }
  };
}

function service(
  db: SqliteDatabase,
  store: FakeMailStore,
  faults?: FaultInjector,
): QuarantineService {
  return new QuarantineService({
    db,
    store,
    now: () => NOW,
    ...(faults !== undefined ? { faults } : {}),
  });
}

describe("quarantine recovery", () => {
  it("copies to the inbox, deletes the quarantine copy, and marks recovered", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    const quarantine = service(db, store);

    const outcome = await quarantine.recovery.recover("m1");
    expect(outcome).toEqual({ status: "recovered", messageId: "m1" });
    expect(requireQuarantineEntry(db, "m1").status).toBe("recovered");
    expect(await store.getMessageIn(INBOX_MAILBOX, "m1")).toBeDefined();
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "m1")).toBeUndefined();
    expect(await copiesOf(store, "m1")).toBe(1);
    db.close();
  });

  it("is idempotent and never duplicates a recovered message", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    const quarantine = service(db, store);

    await quarantine.recovery.recover("m1");
    const second = await quarantine.recovery.recover("m1");
    expect(second).toEqual({ status: "already_recovered", messageId: "m1" });
    expect(await copiesOf(store, "m1")).toBe(1);
    db.close();
  });

  it("blocks recovery once deletion has started", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    updateQuarantineStatus(db, "m1", "deleting", { operationKey: "user_requested", now: NOW });
    const quarantine = service(db, store);

    const outcome = await quarantine.recovery.recover("m1");
    expect(outcome).toMatchObject({ status: "blocked", reason: "message is deleting" });
    db.close();
  });

  it("repairs a crash before the inbox copy by returning to quarantined", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    const quarantine = service(db, store, crashAt("recovery.before_copy"));

    await expect(quarantine.recovery.recover("m1")).rejects.toThrow("crash");
    expect(requireQuarantineEntry(db, "m1").status).toBe("recovering");
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "m1")).toBeDefined();
    expect(await store.getMessageIn(INBOX_MAILBOX, "m1")).toBeUndefined();

    const report = await quarantine.reconcile();
    expect(report.requarantined).toBe(1);
    expect(requireQuarantineEntry(db, "m1").status).toBe("quarantined");

    const retry = await quarantine.recovery.recover("m1");
    expect(retry.status).toBe("recovered");
    db.close();
  });

  it("repairs a crash between copy and delete by keeping the inbox copy", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    const quarantine = service(db, store, crashAt("recovery.after_copy"));

    await expect(quarantine.recovery.recover("m1")).rejects.toThrow("crash");
    expect(requireQuarantineEntry(db, "m1").status).toBe("recovering");
    expect(await copiesOf(store, "m1")).toBe(2);

    const report = await quarantine.reconcile();
    expect(report.recovered).toBe(1);
    expect(requireQuarantineEntry(db, "m1").status).toBe("recovered");
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "m1")).toBeUndefined();
    expect(await store.getMessageIn(INBOX_MAILBOX, "m1")).toBeDefined();
    expect(await copiesOf(store, "m1")).toBe(1);
    db.close();
  });

  it("repairs a crash after delete by marking recovered", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    const quarantine = service(db, store, crashAt("recovery.after_delete"));

    await expect(quarantine.recovery.recover("m1")).rejects.toThrow("crash");
    expect(requireQuarantineEntry(db, "m1").status).toBe("recovering");
    expect(await copiesOf(store, "m1")).toBe(1);

    const report = await quarantine.reconcile();
    expect(report.recovered).toBe(1);
    expect(requireQuarantineEntry(db, "m1").status).toBe("recovered");
    expect(await store.getMessageIn(INBOX_MAILBOX, "m1")).toBeDefined();
    db.close();
  });
});
