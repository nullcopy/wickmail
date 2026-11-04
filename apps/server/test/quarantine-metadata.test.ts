import { describe, expect, it } from "vitest";
import { quarantineStatusSchema } from "wickmail-core";
import { readMessageByIdentity } from "../src/mailstore/adapter.js";
import { FakeMailStore } from "../src/mailstore/fake.js";
import { recordQuarantineFromStore } from "../src/quarantine/metadata.js";
import { QuarantineReconciler } from "../src/quarantine/reconciliation.js";
import {
  getQuarantineEntry,
  listQuarantineEntries,
  requireQuarantineEntry,
  setQuarantineLocator,
  toQuarantinedMessage,
  updateQuarantineStatus,
} from "../src/quarantine/repository.js";
import {
  defaultQuarantineRetentionPolicy,
  QUARANTINE_MAILBOX,
  SPAM_MAILBOX,
  type QuarantineStatus,
} from "../src/quarantine/types.js";
import { createTestDatabase, DAY_MS, NOW } from "./helpers.js";
import { seedAliases, seedQuarantinedMessage } from "./quarantine-helpers.js";

describe("quarantine metadata", () => {
  it("records message ID, aliases, sender, subject, received time, expiry, status, and locator", () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    const [first, second] = seedAliases(db, 2);
    const { locator } = seedQuarantinedMessage(db, store, {
      messageId: "m1",
      aliasIds: [second!, first!],
      sender: "shop@example.net",
      subject: "Your receipt",
      receivedAt: NOW,
      retentionDays: 30,
    });

    const entry = requireQuarantineEntry(db, "m1");
    expect(entry.messageId).toBe("m1");
    expect(entry.aliasIds).toEqual([first, second].sort());
    expect(entry.sender).toBe("shop@example.net");
    expect(entry.subject).toBe("Your receipt");
    expect(entry.receivedAt).toBe(NOW);
    expect(entry.quarantineExpiresAt).toBe(NOW + 30 * DAY_MS);
    expect(entry.status).toBe("quarantined");
    expect(entry.locator).toEqual(locator);
    db.close();
  });

  it("supports every lifecycle status", () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });

    const statuses: QuarantineStatus[] = [
      "recovering",
      "recovered",
      "deleting",
      "deleted",
      "quarantined",
    ];
    for (const status of statuses) {
      const entry = updateQuarantineStatus(db, "m1", status, { now: NOW });
      expect(entry.status).toBe(status);
      expect(quarantineStatusSchema.parse(entry.status)).toBe(status);
    }
    db.close();
  });

  it("lists entries oldest first with a stable secondary sort", () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m2", receivedAt: NOW + 10 });
    seedQuarantinedMessage(db, store, { messageId: "m1", receivedAt: NOW + 10 });
    seedQuarantinedMessage(db, store, { messageId: "m0", receivedAt: NOW });

    expect(listQuarantineEntries(db).map((entry) => entry.messageId)).toEqual(["m0", "m1", "m2"]);
    db.close();
  });

  it("maps metadata to the shared management-API shape", () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1", receivedAt: NOW, retentionDays: 14 });
    const message = toQuarantinedMessage(requireQuarantineEntry(db, "m1"));
    expect(message).toMatchObject({
      messageId: "m1",
      status: "quarantined",
      receivedAt: new Date(NOW).toISOString(),
      quarantineExpiresAt: new Date(NOW + 14 * DAY_MS).toISOString(),
    });
    db.close();
  });

  it("rebuilds the locator cache from the mail store", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    const locator = store.put(QUARANTINE_MAILBOX, "m1", quarantineBody(), NOW);

    // No metadata yet: reconciliation rebuilds it from the mail store.
    const reconciler = new QuarantineReconciler({
      db,
      store,
      policy: defaultQuarantineRetentionPolicy(),
    });
    const report = await reconciler.runOnce();
    expect(report.rebuilt).toBe(1);

    const entry = requireQuarantineEntry(db, "m1");
    expect(entry.locator).toEqual(locator);
    expect(entry.sender).toBe("sender@example.net");
    expect(entry.subject).toBe("Quarantined message");
    db.close();
  });

  it("refreshes a stale locator without treating it as identity", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    seedQuarantinedMessage(db, store, { messageId: "m1" });
    const original = requireQuarantineEntry(db, "m1");

    // A stale locator must never change which message is read.
    setQuarantineLocator(db, "m1", { mailbox: "Inbox", uidValidity: 1, uid: 999 }, NOW);
    const stale = requireQuarantineEntry(db, "m1");
    const read = await readMessageByIdentity(store, "m1", stale.locator!);
    expect(read?.messageId).toBe("m1");

    const reconciler = new QuarantineReconciler({
      db,
      store,
      policy: defaultQuarantineRetentionPolicy(),
    });
    await reconciler.runOnce();
    const refreshed = requireQuarantineEntry(db, "m1");
    expect(refreshed.locator).toEqual(original.locator);
    db.close();
  });

  it("records metadata from a stored message's trusted headers", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    const [aliasId] = seedAliases(db, 1);
    store.put(QUARANTINE_MAILBOX, "m1", quarantineBody(aliasId), NOW);
    const message = await store.getMessage("m1");
    recordQuarantineFromStore(db, message!, defaultQuarantineRetentionPolicy());
    const entry = getQuarantineEntry(db, "m1");
    expect(entry?.aliasIds).toEqual([aliasId]);
    db.close();
  });

  it("derives the retention window from the mailbox", async () => {
    const db = createTestDatabase();
    const store = new FakeMailStore();
    store.put(QUARANTINE_MAILBOX, "lease", quarantineBody(), NOW);
    store.put(SPAM_MAILBOX, "spam", quarantineBody(), NOW);
    const policy = defaultQuarantineRetentionPolicy();
    recordQuarantineFromStore(db, (await store.getMessage("lease"))!, policy);
    recordQuarantineFromStore(db, (await store.getMessage("spam"))!, policy);

    expect(requireQuarantineEntry(db, "lease").quarantineExpiresAt).toBe(NOW + 30 * DAY_MS);
    expect(requireQuarantineEntry(db, "spam").quarantineExpiresAt).toBe(NOW + 14 * DAY_MS);
    db.close();
  });
});

function quarantineBody(aliasId?: string): string {
  return [
    "X-Wickmail-Message-ID: m1",
    ...(aliasId ? [`X-Wickmail-Alias-ID: ${aliasId}`] : []),
    "X-Wickmail-Route: Aliases/Expired",
    `X-Wickmail-Received-At: ${new Date(NOW).toISOString()}`,
    "From: sender@example.net",
    "Subject: Quarantined message",
    "",
    "body",
  ].join("\r\n");
}
