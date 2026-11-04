import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReplyContext } from "wickmail-core";
import { getAliasById } from "../src/alias/repository.js";
import type { SqliteDatabase } from "../src/db/database.js";
import { MailProxy } from "../src/lmtp/proxy.js";
import { getHeader } from "../src/mail/headers.js";
import { FakeMailStore } from "../src/mailstore/fake.js";
import { runReplyCli } from "../src/reply/cli.js";
import { ReplyClient } from "../src/reply/client.js";
import { createDkimSigner, verifyDkimSignature } from "../src/reply/dkim.js";
import { MemoryOutboundQueue } from "../src/reply/queue.js";
import { FileSpool } from "../src/spool/file-spool.js";
import { createTempDirectory, removeTempDirectory, DAY_MS, NOW, TEST_DOMAIN } from "./helpers.js";
import { createTestDatabase } from "./helpers.js";
import { createTestAlias } from "./mail-helpers.js";

const tempDirectories: string[] = [];
let db: SqliteDatabase;

afterEach(() => {
  db?.close();
  while (tempDirectories.length > 0) {
    removeTempDirectory(tempDirectories.pop()!);
  }
});

const PRIMARY = "me@example.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

interface Harness {
  db: SqliteDatabase;
  mailStore: FakeMailStore;
  queue: MemoryOutboundQueue;
  client: ReplyClient;
  proxy: MailProxy;
  spool: FileSpool;
}

function startHarness(): Harness {
  const directory = createTempDirectory();
  tempDirectories.push(directory);
  const database = createTestDatabase();
  const spool = new FileSpool({ directory: join(directory, "spool") });
  const proxy = new MailProxy({
    db: database,
    spool,
    localDomains: [TEST_DOMAIN],
    primaryAddresses: [PRIMARY],
    now: () => NOW,
  });
  const mailStore = new FakeMailStore();
  const queue = new MemoryOutboundQueue();
  const client = new ReplyClient({
    db: database,
    mailStore,
    queue,
    primaryAddress: PRIMARY,
    signer: createDkimSigner({ selector: "wickmail", privateKey: PRIVATE_PEM }),
    now: () => NOW,
    generateMessageId: () => "018f0d9c-0000-7000-8000-00000000abcd",
  });
  db = database;
  return { db: database, mailStore, queue, client, proxy, spool };
}

async function ingest(harness: Harness, rcptTo: string[], raw: string): Promise<string> {
  const result = await harness.proxy.deliver({
    mailFrom: "sender@example.net",
    rcptTo,
    data: raw,
    receivedAt: NOW,
  });
  if (result.status !== "accepted") {
    throw new Error(`delivery failed: ${result.reason}`);
  }
  const spooled = await harness.spool.get(result.messageId);
  harness.mailStore.put("Inbox", result.messageId, spooled!.raw, NOW);
  return result.messageId;
}

function collector(): {
  out: string[];
  err: string[];
  io: { out: (l: string) => void; err: (l: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } };
}

describe("reply path integration", () => {
  it("fetches sanitized context and submits a DKIM-signed reply as the alias", async () => {
    const harness = startHarness();
    const alias = createTestAlias(harness.db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
      renewOnOutbound: true,
    });

    const messageId = await ingest(
      harness,
      ["green.farm@example.com"],
      [
        "X-Wickmail-Route: Spam",
        "From: Sender Name <sender@example.net>",
        "To: green.farm@example.com",
        "Subject: Your order",
        "Message-ID: <orig@example.net>",
        "",
        "Thanks for your order.",
      ].join("\r\n"),
    );

    const context = await harness.client.fetchReplyContext(messageId);
    expect(context).toBeDefined();
    expect(context!.sender).toBe("sender@example.net");
    expect(context!.subject).toBe("Your order");
    expect(context!.text).toBe("Thanks for your order.");
    expect(context!.identity.selected).toEqual({
      kind: "alias",
      aliasId: alias.id,
      address: "green.farm@example.com",
    });

    const result = await harness.client.submitReply(messageId, {
      aliasId: alias.id,
      body: "You're welcome.",
      quotedText: "Thanks for your order.",
    });
    expect(result).toMatchObject({ status: "queued", renewed: true });

    const queued = await harness.queue.list();
    expect(queued).toHaveLength(1);
    const outbound = queued[0]!;
    expect(getHeader(outbound.raw, "From")).toBe("green.farm@example.com");
    expect(getHeader(outbound.raw, "To")).toBe("sender@example.net");
    expect(getHeader(outbound.raw, "Reply-To")).toBeUndefined();
    expect(outbound.raw).not.toContain("X-Wickmail-");
    expect(verifyDkimSignature(outbound.raw, PUBLIC_PEM).valid).toBe(true);
    expect(getAliasById(harness.db, alias.id)!.expiresAt).toBe(NOW + 3600 * 1000);
  });

  it("prompts instead of selecting when multiple aliases received the message", async () => {
    const harness = startHarness();
    const first = createTestAlias(harness.db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
    });
    const second = createTestAlias(harness.db, {
      address: "blue.sky@example.com",
      expiresAt: NOW + DAY_MS,
    });

    const messageId = await ingest(
      harness,
      ["green.farm@example.com", "blue.sky@example.com"],
      "From: sender@example.net\r\nSubject: Both\r\n\r\nbody",
    );

    const context = await harness.client.fetchReplyContext(messageId);
    expect(context!.identity.selection).toBe("prompt");
    expect(context!.identity.selected).toBeNull();
    expect(context!.identity.options).toEqual(
      expect.arrayContaining([
        { kind: "alias", aliasId: first.id, address: first.address },
        { kind: "alias", aliasId: second.id, address: second.address },
      ]),
    );

    const withoutChoice = await harness.client.submitReply(messageId, { body: "hi" });
    expect(withoutChoice).toMatchObject({ status: "rejected" });

    const withChoice = await harness.client.submitReply(messageId, {
      aliasId: second.id,
      body: "hi",
    });
    expect(withChoice).toMatchObject({ status: "queued" });
    const queued = await harness.queue.list();
    expect(getHeader(queued[0]!.raw, "From")).toBe("blue.sky@example.com");
  });

  it("drives context fetch and reply submission through the CLI", async () => {
    const harness = startHarness();
    const alias = createTestAlias(harness.db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
    });
    const messageId = await ingest(
      harness,
      ["green.farm@example.com"],
      "From: sender@example.net\r\nSubject: CLI\r\n\r\nbody",
    );

    const contextIo = collector();
    expect(await runReplyCli(["context", messageId], harness.client, contextIo.io)).toBe(0);
    const context = JSON.parse(contextIo.out.join("\n")) as ReplyContext;
    expect(context.subject).toBe("CLI");
    expect(context.identity.selected).toEqual({
      kind: "alias",
      aliasId: alias.id,
      address: alias.address,
    });

    const replyIo = collector();
    expect(
      await runReplyCli(
        ["reply", messageId, "--alias", alias.id, "--body", "hello", "--quote", "body"],
        harness.client,
        replyIo.io,
      ),
    ).toBe(0);
    expect(JSON.parse(replyIo.out.join("\n"))).toMatchObject({ status: "queued" });
    expect(await harness.queue.list()).toHaveLength(1);
  });

  it("reports a rejected identity through the CLI", async () => {
    const harness = startHarness();
    const first = createTestAlias(harness.db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
    });
    createTestAlias(harness.db, { address: "blue.sky@example.com", expiresAt: NOW + DAY_MS });
    const messageId = await ingest(
      harness,
      ["green.farm@example.com", "blue.sky@example.com"],
      "From: sender@example.net\r\nSubject: Both\r\n\r\nbody",
    );

    const io = collector();
    // The message went to two aliases, so the CLI must not choose one silently.
    expect(await runReplyCli(["reply", messageId, "--body", "hi"], harness.client, io.io)).toBe(1);
    expect(JSON.parse(io.out.join("\n"))).toMatchObject({ status: "rejected" });
    expect(first.id).toBeTruthy();
  });
});
