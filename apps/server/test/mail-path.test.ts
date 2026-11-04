import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { getAliasById } from "../src/alias/repository.js";
import { migrate, migrations, openDatabase } from "../src/db/index.js";
import type { SqliteDatabase } from "../src/db/database.js";
import {
  FailingDeliveryTarget,
  RecordingDeliveryTarget,
  type DeliveryTarget,
} from "../src/delivery/target.js";
import { MailPath } from "../src/mail-path.js";
import { SpoolWorker } from "../src/spool/worker.js";
import { SpoolFullError, SpoolUnavailableError, type Spool } from "../src/spool/types.js";
import { createTempDirectory, removeTempDirectory, DAY_MS, NOW, TEST_DOMAIN } from "./helpers.js";
import { createTestAlias } from "./mail-helpers.js";
import { TestLineClient } from "./support.js";

interface Harness {
  db: SqliteDatabase;
  spool: Spool;
  target: RecordingDeliveryTarget;
  mailPath: MailPath;
  policyPort: number;
  lmtpPort: number;
  close: () => Promise<void>;
}

const harnesses: Harness[] = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()!.close();
  }
  while (tempDirectories.length > 0) {
    removeTempDirectory(tempDirectories.pop()!);
  }
});

async function startHarness(
  overrideTarget?: DeliveryTarget,
  overrideSpool?: Spool,
): Promise<Harness> {
  const directory = createTempDirectory();
  tempDirectories.push(directory);
  const db = openDatabase({ path: join(directory, "wickmail.db") });
  migrate(db, migrations);
  const recording = new RecordingDeliveryTarget();
  const target = overrideTarget ?? recording;
  const mailPath = new MailPath({
    db,
    config: {
      hostname: "wickmail.test",
      localDomains: [TEST_DOMAIN],
      primaryAddresses: ["me@example.com"],
      spoolDirectory: join(directory, "spool"),
    },
    target,
    now: () => NOW,
    ...(overrideSpool !== undefined ? { spool: overrideSpool } : {}),
  });
  const policyAddress = (await mailPath.listenPolicy({ port: 0 })) as AddressInfo;
  const lmtpAddress = (await mailPath.listenLmtp({ port: 0 })) as AddressInfo;
  const harness: Harness = {
    db,
    spool: mailPath.spool,
    target: recording,
    mailPath,
    policyPort: policyAddress.port,
    lmtpPort: lmtpAddress.port,
    close: async () => {
      await mailPath.close();
      try {
        db.close();
      } catch {
        // The policy-outage test closes the database itself.
      }
    },
  };
  harnesses.push(harness);
  return harness;
}

async function socketmapLookup(port: number, address: string): Promise<string> {
  const client = await TestLineClient.connect(port);
  client.write(`recipient ${address}\n`);
  const response = await client.readLine();
  client.end();
  return response;
}

async function lmtpDeliver(
  port: number,
  input: { mailFrom: string; rcptTo: string; data: string },
): Promise<{ dataReply: string[]; messageId: string | null }> {
  const client = await TestLineClient.connect(port);
  await client.readLine();
  client.write("LHLO harness.example\r\n");
  await client.readReply();
  client.write(`MAIL FROM:<${input.mailFrom}>\r\n`);
  await client.readReply();
  client.write(`RCPT TO:<${input.rcptTo}>\r\n`);
  await client.readReply();
  client.write("DATA\r\n");
  await client.readReply();
  client.write(`${input.data}\r\n.\r\n`);
  const dataReply = await client.readReply();
  client.write("QUIT\r\n");
  await client.readReply();
  client.end();
  const match = dataReply.join(" ").match(/queued as (\S+)/);
  return { dataReply, messageId: match?.[1] ?? null };
}

describe("inbound mail path harness", () => {
  it("accepts an active alias at RCPT and delivers it to the inbox", async () => {
    const harness = await startHarness();
    const alias = createTestAlias(harness.db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
    });

    expect(await socketmapLookup(harness.policyPort, "green.farm@example.com")).toBe("OK OK");

    const { dataReply, messageId } = await lmtpDeliver(harness.lmtpPort, {
      mailFrom: "sender@example.net",
      rcptTo: "green.farm@example.com",
      data: [
        "X-Wickmail-Route: Spam",
        "From: sender@example.net",
        "To: green.farm@example.com",
        "Subject: Hello",
        "",
        "Body",
      ].join("\r\n"),
    });
    expect(TestLineClient.status(dataReply)).toBe(250);
    expect(messageId).not.toBeNull();

    // The message is durably spooled before the ack and the trusted route wins.
    const spooled = await harness.spool.list();
    expect(spooled).toHaveLength(1);
    expect(spooled[0]!.route).toBe("Inbox");
    expect(spooled[0]!.raw).toContain("X-Wickmail-Route: Inbox");
    expect(spooled[0]!.raw).not.toContain("X-Wickmail-Route: Spam");

    expect(await harness.mailPath.worker.runOnce()).toEqual({ delivered: 1, retried: 0 });
    expect(harness.target.delivered).toHaveLength(1);
    expect(harness.target.delivered[0]!.route).toBe("Inbox");

    expect(getAliasById(harness.db, alias.id)!.lastInboundAt).toBe(NOW);
  });

  it("routes mail for an expired alias to Aliases/Expired", async () => {
    const harness = await startHarness();
    createTestAlias(harness.db, { address: "old.alias@example.com", expiresAt: NOW - DAY_MS });

    // Expired recipients are accepted at RCPT.
    expect(await socketmapLookup(harness.policyPort, "old.alias@example.com")).toBe("OK OK");

    const { dataReply } = await lmtpDeliver(harness.lmtpPort, {
      mailFrom: "sender@example.net",
      rcptTo: "old.alias@example.com",
      data: "From: sender@example.net\r\n\r\nbody",
    });
    expect(TestLineClient.status(dataReply)).toBe(250);

    const spooled = await harness.spool.list();
    expect(spooled[0]!.route).toBe("Aliases/Expired");
    await harness.mailPath.worker.runOnce();
    expect(harness.target.delivered[0]!.route).toBe("Aliases/Expired");
  });

  it("rejects unknown and disabled recipients at RCPT", async () => {
    const harness = await startHarness();
    createTestAlias(harness.db, {
      address: "off.led@example.com",
      expiresAt: NOW + DAY_MS,
      disabledAt: NOW - 1,
    });

    expect(await socketmapLookup(harness.policyPort, "nobody@example.com")).toBe(
      "OK REJECT unknown recipient",
    );
    expect(await socketmapLookup(harness.policyPort, "off.led@example.com")).toBe(
      "OK REJECT disabled recipient",
    );
    // A primary address is always accepted.
    expect(await socketmapLookup(harness.policyPort, "me@example.com")).toBe("OK OK");
  });

  it("returns a temporary failure, not a permanent rejection, when policy is unavailable", async () => {
    const harness = await startHarness();
    createTestAlias(harness.db, { address: "green.farm@example.com", expiresAt: null });
    harness.db.close();

    const response = await socketmapLookup(harness.policyPort, "green.farm@example.com");
    // The lookup succeeds and returns a temporary access decision, which
    // Postfix maps to a 4xx defer. It is never an unknown-recipient rejection.
    expect(response).toContain("DEFER");
    expect(response).not.toContain("REJECT");
  });

  it("strips every spoofed X-Wickmail-* header and adds trusted headers", async () => {
    const harness = await startHarness();
    createTestAlias(harness.db, { address: "green.farm@example.com", expiresAt: null });

    const { messageId } = await lmtpDeliver(harness.lmtpPort, {
      mailFrom: "sender@example.net",
      rcptTo: "green.farm@example.com",
      data: [
        "X-Wickmail-Message-ID: attacker",
        "X-Wickmail-Alias-ID: 11111111-1111-4111-8111-111111111111",
        "x-wickmail-received-at: 1970-01-01T00:00:00Z",
        "From: sender@example.net",
        "",
        "body",
      ].join("\r\n"),
    });

    const spooled = (await harness.spool.list())[0]!;
    expect(spooled.id).toBe(messageId);
    expect(spooled.raw).not.toContain("attacker");
    expect(spooled.raw).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(spooled.raw).not.toContain("1970-01-01T00:00:00Z");
    expect(spooled.raw).toContain(`X-Wickmail-Message-ID: ${messageId}`);
    expect(spooled.raw).toContain("X-Wickmail-Route: Inbox");
  });

  it("keeps a message in the spool and retries it without bouncing when downstream is down", async () => {
    const harness = await startHarness(new FailingDeliveryTarget("dovecot down"));
    createTestAlias(harness.db, { address: "green.farm@example.com", expiresAt: null });

    const { dataReply } = await lmtpDeliver(harness.lmtpPort, {
      mailFrom: "sender@example.net",
      rcptTo: "green.farm@example.com",
      data: "From: sender@example.net\r\n\r\nbody",
    });
    // The message was accepted and spooled before the downstream failure.
    expect(TestLineClient.status(dataReply)).toBe(250);

    expect(await harness.mailPath.worker.runOnce()).toEqual({ delivered: 0, retried: 1 });
    expect(await harness.spool.list()).toHaveLength(1);

    // Recovery: a worker over the same spool delivers the retained message.
    const recovered = new RecordingDeliveryTarget();
    const recoveryWorker = new SpoolWorker(harness.spool, recovered, {
      now: () => NOW + 10 * 60 * 1000,
    });
    expect(await recoveryWorker.runOnce()).toEqual({ delivered: 1, retried: 0 });
    expect(recovered.delivered).toHaveLength(1);
    expect(await harness.spool.list()).toHaveLength(0);
  });

  it("defers at LMTP, before acceptance, when the spool is unavailable", async () => {
    const harness = await startHarness(
      undefined,
      new FailingSpool(new SpoolUnavailableError("spool directory is missing")),
    );
    createTestAlias(harness.db, { address: "green.farm@example.com", expiresAt: null });

    const { dataReply } = await lmtpDeliver(harness.lmtpPort, {
      mailFrom: "sender@example.net",
      rcptTo: "green.farm@example.com",
      data: "From: sender@example.net\r\n\r\nbody",
    });

    // A spool failure is a 4xx defer, never a 5xx permanent rejection.
    expect(TestLineClient.status(dataReply)).toBe(451);
    expect(dataReply.join(" ")).toContain("spool");
  });

  it("defers at LMTP, before acceptance, when the spool is full", async () => {
    const harness = await startHarness(
      undefined,
      new FailingSpool(new SpoolFullError("spool filesystem is full")),
    );
    createTestAlias(harness.db, { address: "green.farm@example.com", expiresAt: null });

    const { dataReply } = await lmtpDeliver(harness.lmtpPort, {
      mailFrom: "sender@example.net",
      rcptTo: "green.farm@example.com",
      data: "From: sender@example.net\r\n\r\nbody",
    });

    // Spool exhaustion is reported as an alertable full-spool error and a 4xx
    // defer, so the MTA retries instead of bouncing the message.
    expect(TestLineClient.status(dataReply)).toBe(451);
    expect(dataReply.join(" ")).toContain("spool");
  });

  it("does not renew an alias from a spoofed inbound MAIL FROM", async () => {
    const harness = await startHarness();
    const expiresAt = NOW + DAY_MS;
    const alias = createTestAlias(harness.db, {
      address: "green.farm@example.com",
      expiresAt,
      leaseDurationSeconds: 3600,
      renewOnOutbound: true,
    });

    // The envelope sender forges the alias's own address. Inbound mail cannot
    // extend its own delivery window, so the lease is untouched.
    const { dataReply } = await lmtpDeliver(harness.lmtpPort, {
      mailFrom: "green.farm@example.com",
      rcptTo: "green.farm@example.com",
      data: "From: green.farm@example.com\r\n\r\nbody",
    });
    expect(TestLineClient.status(dataReply)).toBe(250);

    const stored = getAliasById(harness.db, alias.id)!;
    expect(stored.expiresAt).toBe(expiresAt);
    expect(stored.lastInboundAt).toBe(NOW);
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
