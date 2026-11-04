import { describe, expect, it } from "vitest";
import type { SqliteDatabase } from "../src/db/database.js";
import { FakeMailStore } from "../src/mailstore/fake.js";
import {
  getQuarantineEntry,
  purgeDeletedMetadata,
  requireQuarantineEntry,
  updateQuarantineStatus,
} from "../src/quarantine/repository.js";
import { QuarantineService } from "../src/quarantine/service.js";
import type { FaultInjector, QuarantineFaultPoint } from "../src/quarantine/types.js";
import { INBOX_MAILBOX, QUARANTINE_MAILBOX } from "../src/quarantine/types.js";
import { createTestDatabase, DAY_MS, NOW } from "./helpers.js";
import { seedQuarantinedMessage } from "./quarantine-helpers.js";

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

describe("quarantine deletion", () => {
  it("marks deleting with a reason, deletes the body, then marks deleted", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });

    let statusWhenDeleting: string | undefined;
    let reasonWhenDeleting: string | null | undefined;
    let bodyWhenDeleting: boolean | undefined;
    const inspect: FaultInjector = async (point) => {
      if (point === "deletion.before_body_delete") {
        const entry = requireQuarantineEntry(db, "m1");
        statusWhenDeleting = entry.status;
        reasonWhenDeleting = entry.operationKey;
        bodyWhenDeleting = (await store.getMessageIn(QUARANTINE_MAILBOX, "m1")) !== undefined;
      }
    };

    const outcome = await service(db, store, inspect).delete("m1", {
      reason: "user_requested",
    });
    expect(outcome).toEqual({ status: "deleted", messageId: "m1" });
    expect(statusWhenDeleting).toBe("deleting");
    expect(reasonWhenDeleting).toBe("user_requested");
    expect(bodyWhenDeleting).toBe(true);
    const entry = requireQuarantineEntry(db, "m1");
    expect(entry.status).toBe("deleted");
    expect(entry.operationKey).toBe("user_requested");
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "m1")).toBeUndefined();
    db.close();
  });

  it("is idempotent", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    const quarantine = service(db, store);

    await quarantine.delete("m1", { reason: "user_requested" });
    const second = await quarantine.delete("m1", { reason: "user_requested" });
    expect(second).toEqual({ status: "already_deleted", messageId: "m1" });
    db.close();
  });

  it("blocks recovery while deletion is in flight", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    const quarantine = service(db, store, crashAt("deletion.before_body_delete"));

    await expect(quarantine.delete("m1", { reason: "user_requested" })).rejects.toThrow("crash");
    expect(requireQuarantineEntry(db, "m1").status).toBe("deleting");

    const outcome = await quarantine.recovery.recover("m1");
    expect(outcome).toMatchObject({ status: "blocked", reason: "message is deleting" });
    db.close();
  });

  it("refuses to delete a message whose recovery is in flight", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    updateQuarantineStatus(db, "m1", "recovering", { operationKey: "k1", now: NOW });
    const quarantine = service(db, store);

    const outcome = await quarantine.deletion.delete("m1", { reason: "user_requested" });
    expect(outcome).toMatchObject({ status: "blocked", reason: "recovery is in progress" });
    db.close();
  });

  it("repairs a crash before body deletion", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    const quarantine = service(db, store, crashAt("deletion.before_body_delete"));

    await expect(quarantine.delete("m1", { reason: "user_requested" })).rejects.toThrow("crash");
    expect(requireQuarantineEntry(db, "m1").status).toBe("deleting");
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "m1")).toBeDefined();

    await quarantine.reconcile();
    expect(requireQuarantineEntry(db, "m1").status).toBe("deleted");
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "m1")).toBeUndefined();
    db.close();
  });

  it("repairs a crash after body deletion", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    const quarantine = service(db, store, crashAt("deletion.after_body_delete"));

    await expect(quarantine.delete("m1", { reason: "retention_expired" })).rejects.toThrow("crash");
    expect(requireQuarantineEntry(db, "m1").status).toBe("deleting");
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "m1")).toBeUndefined();

    await quarantine.reconcile();
    expect(requireQuarantineEntry(db, "m1").status).toBe("deleted");
    db.close();
  });

  it("deletes a recovered message's metadata without touching the inbox copy", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    await store.copyMessage("m1", INBOX_MAILBOX);
    await store.deleteMessage(QUARANTINE_MAILBOX, "m1");
    updateQuarantineStatus(db, "m1", "recovered", { now: NOW });
    const quarantine = service(db, store);

    const outcome = await quarantine.delete("m1", { reason: "user_requested" });
    expect(outcome).toEqual({ status: "deleted", messageId: "m1" });
    expect(requireQuarantineEntry(db, "m1").status).toBe("deleted");
    expect(await store.getMessageIn(INBOX_MAILBOX, "m1")).toBeDefined();
    db.close();
  });

  it("purges deleted metadata only after the grace period", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    await service(db, store).delete("m1", { reason: "user_requested" });

    const graceMs = 7 * DAY_MS;
    expect(purgeDeletedMetadata(db, { now: NOW + 3 * DAY_MS, graceMs })).toBe(0);
    expect(getQuarantineEntry(db, "m1")).toBeDefined();

    expect(purgeDeletedMetadata(db, { now: NOW + 8 * DAY_MS, graceMs })).toBe(1);
    expect(getQuarantineEntry(db, "m1")).toBeUndefined();
    db.close();
  });
});
