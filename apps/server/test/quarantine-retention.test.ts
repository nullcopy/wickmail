import { describe, expect, it } from "vitest";
import type { SqliteDatabase } from "../src/db/database.js";
import { FakeMailStore } from "../src/mailstore/fake.js";
import { requireQuarantineEntry, updateQuarantineStatus } from "../src/quarantine/repository.js";
import { QuarantineService } from "../src/quarantine/service.js";
import type { RetentionReport } from "../src/quarantine/retention.js";
import {
  DEFAULT_LEASE_RETENTION_DAYS,
  DEFAULT_SPAM_RETENTION_DAYS,
  defaultQuarantineRetentionPolicy,
  QUARANTINE_MAILBOX,
  SPAM_MAILBOX,
  type FaultInjector,
  type QuarantineFaultPoint,
  type QuarantineRetentionPolicy,
} from "../src/quarantine/types.js";
import { createTestDatabase, DAY_MS, NOW } from "./helpers.js";
import { copiesOf, seedAliases, seedQuarantinedMessage } from "./quarantine-helpers.js";

function policy(overrides: Partial<QuarantineRetentionPolicy> = {}): QuarantineRetentionPolicy {
  return { ...defaultQuarantineRetentionPolicy(), ...overrides };
}

function service(
  db: SqliteDatabase,
  store: FakeMailStore,
  options: {
    clock?: () => number;
    policy?: QuarantineRetentionPolicy;
    faults?: FaultInjector;
  } = {},
): QuarantineService {
  return new QuarantineService({
    db,
    store,
    now: options.clock ?? (() => NOW),
    policy: options.policy ?? defaultQuarantineRetentionPolicy(),
    ...(options.faults !== undefined ? { faults: options.faults } : {}),
  });
}

function crashAt(point: QuarantineFaultPoint): FaultInjector {
  let fired = false;
  return (at) => {
    if (!fired && at === point) {
      fired = true;
      throw new Error(`crash at ${at}`);
    }
  };
}

describe("quarantine retention defaults", () => {
  it("uses 30 days for lease quarantine and 14 for spam, configured separately", () => {
    const defaults = defaultQuarantineRetentionPolicy();
    expect(defaults.leaseRetentionDays).toBe(30);
    expect(defaults.spamRetentionDays).toBe(14);
    expect(DEFAULT_LEASE_RETENTION_DAYS).toBe(30);
    expect(DEFAULT_SPAM_RETENTION_DAYS).toBe(14);
  });
});

describe("quarantine retention expiry", () => {
  it("deletes a lease-quarantine message only after its window", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    let clock = NOW;
    seedQuarantinedMessage(db, store, { messageId: "m1", receivedAt: NOW, retentionDays: 30 });
    const quarantine = service(db, store, { clock: () => clock });

    clock = NOW + 29 * DAY_MS;
    expect((await quarantine.retention.runOnce()).expired).toBe(0);
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "m1")).toBeDefined();

    clock = NOW + 30 * DAY_MS;
    expect((await quarantine.retention.runOnce()).expired).toBe(1);
    expect(requireQuarantineEntry(db, "m1").status).toBe("deleted");
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "m1")).toBeUndefined();
    db.close();
  });

  it("uses the spam window for spam messages", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    let clock = NOW;
    seedQuarantinedMessage(db, store, {
      messageId: "s1",
      mailbox: SPAM_MAILBOX,
      receivedAt: NOW,
      retentionDays: 14,
    });
    const quarantine = service(db, store, { clock: () => clock });

    clock = NOW + 13 * DAY_MS;
    expect((await quarantine.retention.runOnce()).expired).toBe(0);
    clock = NOW + 14 * DAY_MS;
    expect((await quarantine.retention.runOnce()).expired).toBe(1);
    db.close();
  });

  it("applies the lease and spam windows independently", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    let clock = NOW;
    seedQuarantinedMessage(db, store, { messageId: "lease", receivedAt: NOW, retentionDays: 1 });
    seedQuarantinedMessage(db, store, {
      messageId: "spam",
      mailbox: SPAM_MAILBOX,
      receivedAt: NOW,
      retentionDays: 100,
    });
    const quarantine = service(db, store, {
      clock: () => clock,
      policy: policy({ leaseRetentionDays: 1, spamRetentionDays: 100 }),
    });

    clock = NOW + 2 * DAY_MS;
    const report = await quarantine.retention.runOnce();
    expect(report.expired).toBe(1);
    expect(requireQuarantineEntry(db, "lease").status).toBe("deleted");
    expect(requireQuarantineEntry(db, "spam").status).toBe("quarantined");
    db.close();
  });
});

describe("quarantine retention quotas", () => {
  it("deletes the oldest messages first when the count quota is exceeded", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m0", receivedAt: NOW, retentionDays: 100 });
    seedQuarantinedMessage(db, store, {
      messageId: "m1",
      receivedAt: NOW + 1,
      retentionDays: 100,
    });
    seedQuarantinedMessage(db, store, {
      messageId: "m2",
      receivedAt: NOW + 2,
      retentionDays: 100,
    });
    const quarantine = service(db, store, { policy: policy({ quota: { maxMessages: 2 } }) });

    const report = await quarantine.retention.runOnce();
    expect(report.quota).toBe(1);
    expect(requireQuarantineEntry(db, "m0").status).toBe("deleted");
    expect(requireQuarantineEntry(db, "m1").status).toBe("quarantined");
    expect(requireQuarantineEntry(db, "m2").status).toBe("quarantined");
    db.close();
  });

  it("enforces a per-alias count quota oldest first", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    const [aliasId] = seedAliases(db, 1);
    for (let index = 0; index < 3; index += 1) {
      seedQuarantinedMessage(db, store, {
        messageId: `m${index}`,
        aliasIds: [aliasId!],
        receivedAt: NOW + index,
        retentionDays: 100,
      });
    }
    const quarantine = service(db, store, {
      policy: policy({ quota: { maxMessagesPerAlias: 1 } }),
    });

    const report = await quarantine.retention.runOnce();
    expect(report.quota).toBe(2);
    expect(requireQuarantineEntry(db, "m2").status).toBe("quarantined");
    db.close();
  });

  it("enforces a byte quota oldest first", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, {
      messageId: "m0",
      receivedAt: NOW,
      body: "x".repeat(1000),
      retentionDays: 100,
    });
    seedQuarantinedMessage(db, store, {
      messageId: "m1",
      receivedAt: NOW + 1,
      body: "y".repeat(1000),
      retentionDays: 100,
    });
    const quarantine = service(db, store, { policy: policy({ quota: { maxBytes: 1500 } }) });

    const report = await quarantine.retention.runOnce();
    expect(report.quota).toBe(1);
    expect(requireQuarantineEntry(db, "m0").status).toBe("deleted");
    expect(requireQuarantineEntry(db, "m1").status).toBe("quarantined");
    db.close();
  });
});

describe("quarantine retention safety", () => {
  it("never deletes a message in recovering or deleting", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "r", receivedAt: NOW, retentionDays: 0 });
    seedQuarantinedMessage(db, store, { messageId: "d", receivedAt: NOW, retentionDays: 0 });
    updateQuarantineStatus(db, "r", "recovering", { operationKey: "k1", now: NOW });
    updateQuarantineStatus(db, "d", "deleting", { operationKey: "retention_expired", now: NOW });
    const quarantine = service(db, store);

    const report = await quarantine.retention.runOnce();
    expect(report.expired).toBe(0);
    expect(requireQuarantineEntry(db, "r").status).toBe("recovering");
    expect(requireQuarantineEntry(db, "d").status).toBe("deleting");
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "r")).toBeDefined();
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "d")).toBeDefined();
    db.close();
  });

  it("runs retention while recovery is in flight without deleting the message", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1", receivedAt: NOW, retentionDays: 0 });
    const quarantine = service(db, store);

    let duringRecovery: RetentionReport | undefined;
    const faults: FaultInjector = async (point) => {
      if (point === "recovery.after_copy") {
        duringRecovery = await quarantine.retention.runOnce();
      }
    };
    const recovering = new QuarantineService({
      db,
      store,
      now: () => NOW,
      faults,
    });

    const outcome = await recovering.recovery.recover("m1");
    expect(outcome.status).toBe("recovered");
    expect(duringRecovery).toMatchObject({ expired: 0, quota: 0 });
    expect(requireQuarantineEntry(db, "m1").status).toBe("recovered");
    expect(await copiesOf(store, "m1")).toBe(1);
    db.close();
  });

  it("repairs a retention crash before body deletion", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1", receivedAt: NOW, retentionDays: 0 });
    const quarantine = service(db, store, { faults: crashAt("deletion.before_body_delete") });

    await expect(quarantine.retention.runOnce()).rejects.toThrow("crash");
    expect(requireQuarantineEntry(db, "m1").status).toBe("deleting");
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "m1")).toBeDefined();

    await quarantine.reconcile();
    expect(requireQuarantineEntry(db, "m1").status).toBe("deleted");
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "m1")).toBeUndefined();
    db.close();
  });

  it("repairs a retention crash after body deletion", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1", receivedAt: NOW, retentionDays: 0 });
    const quarantine = service(db, store, { faults: crashAt("deletion.after_body_delete") });

    await expect(quarantine.retention.runOnce()).rejects.toThrow("crash");
    expect(requireQuarantineEntry(db, "m1").status).toBe("deleting");
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, "m1")).toBeUndefined();

    await quarantine.reconcile();
    expect(requireQuarantineEntry(db, "m1").status).toBe("deleted");
    db.close();
  });

  it("purges deleted metadata after the grace period", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    let clock = NOW;
    seedQuarantinedMessage(db, store, { messageId: "m1", receivedAt: NOW, retentionDays: 0 });
    const quarantine = service(db, store, {
      clock: () => clock,
      policy: policy({ metadataGraceDays: 7 }),
    });

    await quarantine.retention.runOnce();
    expect(requireQuarantineEntry(db, "m1").status).toBe("deleted");

    clock = NOW + 3 * DAY_MS;
    expect((await quarantine.retention.runOnce()).purged).toBe(0);
    expect(requireQuarantineEntry(db, "m1")).toBeDefined();

    clock = NOW + 8 * DAY_MS;
    expect((await quarantine.retention.runOnce()).purged).toBe(1);
    db.close();
  });
});
