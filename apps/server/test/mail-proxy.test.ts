import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAliasById } from "../src/alias/repository.js";
import { migrate, migrations, openDatabase } from "../src/db/index.js";
import type { SqliteDatabase } from "../src/db/database.js";
import { MailProxy } from "../src/lmtp/proxy.js";
import { getProvenance } from "../src/provenance/repository.js";
import { FileSpool } from "../src/spool/file-spool.js";
import { SpoolFullError, type Spool } from "../src/spool/types.js";
import { createTempDirectory, removeTempDirectory, DAY_MS, NOW, TEST_DOMAIN } from "./helpers.js";
import { createTestAlias } from "./mail-helpers.js";

const tempDirectories: string[] = [];
let db: SqliteDatabase;

afterEach(() => {
  db?.close();
  while (tempDirectories.length > 0) {
    removeTempDirectory(tempDirectories.pop()!);
  }
});

function fileSpool(): FileSpool {
  const directory = createTempDirectory();
  tempDirectories.push(directory);
  return new FileSpool({ directory: join(directory, "spool") });
}

function proxy(spool: Spool = fileSpool()): MailProxy {
  db = createTestDatabaseWithAliases();
  return new MailProxy({
    db,
    spool,
    localDomains: [TEST_DOMAIN],
    primaryAddresses: ["me@example.com"],
  });
}

function createTestDatabaseWithAliases(): SqliteDatabase {
  const database = openDatabase({ path: ":memory:" });
  migrate(database, migrations);
  return database;
}

const MESSAGE = [
  "X-Wickmail-Route: Inbox",
  "X-Wickmail-Alias-ID: spoofed",
  "From: sender@example.net",
  "To: green.farm@example.com",
  "Subject: Hello",
  "",
  "Body",
].join("\r\n");

describe("MailProxy", () => {
  it("strips spoofed headers and adds trusted headers for an active alias", async () => {
    const spool = fileSpool();
    const mailProxy = proxy(spool);
    const alias = createTestAlias(db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
    });

    const result = await mailProxy.deliver({
      mailFrom: "sender@example.net",
      rcptTo: ["green.farm@example.com"],
      data: MESSAGE,
      receivedAt: NOW,
    });

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.route).toBe("Inbox");
    expect(result.aliasIds).toEqual([alias.id]);

    const stored = await spool.get(result.messageId);
    expect(stored).toBeDefined();
    const raw = stored!.raw;
    expect(raw).toContain(`X-Wickmail-Message-ID: ${result.messageId}`);
    expect(raw).toContain(`X-Wickmail-Alias-ID: ${alias.id}`);
    expect(raw).toContain("X-Wickmail-Route: Inbox");
    expect(raw).toMatch(/X-Wickmail-Received-At: \d{4}-\d{2}-\d{2}T/);
    // The spoofed alias ID was removed; only the trusted one remains.
    expect(raw.match(/X-Wickmail-Alias-ID:/g)).toHaveLength(1);
    expect(raw).not.toContain("X-Wickmail-Alias-ID: spoofed");
    expect(raw).not.toContain("X-Wickmail-Route: Inbox\r\nX-Wickmail-Alias-ID: spoofed");
  });

  it("routes a message to an expired alias into Aliases/Expired", async () => {
    const spool = fileSpool();
    const mailProxy = proxy(spool);
    createTestAlias(db, { address: "old.alias@example.com", expiresAt: NOW - DAY_MS });
    const result = await mailProxy.deliver({
      mailFrom: "sender@example.net",
      rcptTo: ["old.alias@example.com"],
      data: "From: a@b.example\r\n\r\nbody",
      receivedAt: NOW,
    });
    expect(result).toMatchObject({ status: "accepted", route: "Aliases/Expired" });
  });

  it("routes spam to Spam even for an active alias", async () => {
    const spool = fileSpool();
    const mailProxy = proxy(spool);
    createTestAlias(db, { address: "green.farm@example.com", expiresAt: NOW + DAY_MS });
    const result = await mailProxy.deliver({
      mailFrom: "spammer@example.net",
      rcptTo: ["green.farm@example.com"],
      data: "X-Spam-Flag: YES\r\nFrom: spammer@example.net\r\n\r\nbody",
      receivedAt: NOW,
    });
    expect(result).toMatchObject({ status: "accepted", route: "Spam" });
  });

  it("adds one alias ID per receiving alias and records primary receipt", async () => {
    const spool = fileSpool();
    const mailProxy = proxy(spool);
    const first = createTestAlias(db, { address: "green.farm@example.com", expiresAt: null });
    const second = createTestAlias(db, { address: "blue.sky@example.com", expiresAt: null });

    const result = await mailProxy.deliver({
      mailFrom: "sender@example.net",
      rcptTo: ["green.farm@example.com", "me@example.com", "blue.sky@example.com"],
      data: "From: a@b.example\r\n\r\nbody",
      receivedAt: NOW,
    });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.aliasIds.sort()).toEqual([first.id, second.id].sort());
    expect(result.primaryReceived).toBe(true);

    const stored = await spool.get(result.messageId);
    expect(stored!.raw.match(/X-Wickmail-Alias-ID:/g)).toHaveLength(2);
    expect(stored!.primaryReceived).toBe(true);
    expect(stored!.rcptTo).toEqual([
      "green.farm@example.com",
      "me@example.com",
      "blue.sky@example.com",
    ]);
  });

  it("records provenance and updates last_inbound_at at acceptance", async () => {
    const spool = fileSpool();
    const mailProxy = proxy(spool);
    const alias = createTestAlias(db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
    });
    const before = getAliasById(db, alias.id)!;

    const result = await mailProxy.deliver({
      mailFrom: "sender@example.net",
      rcptTo: ["green.farm@example.com"],
      data: "From: a@b.example\r\n\r\nbody",
      receivedAt: NOW + 1000,
    });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;

    const after = getAliasById(db, alias.id)!;
    expect(after.lastInboundAt).toBe(NOW + 1000);
    expect(after.expiresAt).toBe(before.expiresAt);
    expect(after.policyVersion).toBe(before.policyVersion);

    const provenance = (await import("../src/provenance/repository.js")).getProvenance(
      db,
      result.messageId,
    );
    expect(provenance?.aliasIds).toEqual([alias.id]);
    expect(provenance?.envelopeRecipients).toEqual(["green.farm@example.com"]);
  });

  it("cross-checks visible recipients for display only", async () => {
    const spool = fileSpool();
    const mailProxy = proxy(spool);
    createTestAlias(db, { address: "green.farm@example.com", expiresAt: null });
    createTestAlias(db, { address: "blue.sky@example.com", expiresAt: null });
    const result = await mailProxy.deliver({
      mailFrom: "sender@example.net",
      rcptTo: ["green.farm@example.com", "blue.sky@example.com"],
      data: "From: a@b.example\r\nTo: green.farm@example.com\r\n\r\nbody",
      receivedAt: NOW,
    });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.crossCheck.envelopeOnly).toEqual(["blue.sky@example.com"]);
  });

  it("returns a temporary failure when the spool is full, before acceptance", async () => {
    const mailProxy = proxy(new FailingSpool(new SpoolFullError("spool filesystem is full")));
    createTestAlias(db, { address: "green.farm@example.com", expiresAt: null });
    const result = await mailProxy.deliver({
      mailFrom: "sender@example.net",
      rcptTo: ["green.farm@example.com"],
      data: "From: a@b.example\r\n\r\nbody",
      receivedAt: NOW,
    });
    expect(result).toEqual({ status: "tempfail", reason: expect.stringContaining("spool") });
  });

  it("returns a temporary failure for an unknown recipient at delivery", async () => {
    const mailProxy = proxy();
    const result = await mailProxy.deliver({
      mailFrom: "sender@example.net",
      rcptTo: ["nobody@example.com"],
      data: "From: a@b.example\r\n\r\nbody",
      receivedAt: NOW,
    });
    expect(result.status).toBe("tempfail");
  });
});

class FailingSpool implements Spool {
  constructor(private readonly error: Error) {}
  async enqueue(): Promise<void> {
    throw this.error;
  }
  async list() {
    return [];
  }
  async get() {
    return undefined;
  }
  async remove(): Promise<void> {}
  async recordAttempt(): Promise<void> {}
  async stats() {
    return { depth: 0, oldestAgeMs: null };
  }
}
