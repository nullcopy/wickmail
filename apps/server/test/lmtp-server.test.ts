import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, migrations, openDatabase } from "../src/db/index.js";
import type { SqliteDatabase } from "../src/db/database.js";
import { MailProxy } from "../src/lmtp/proxy.js";
import { createLmtpServer, type LmtpMessageSink } from "../src/lmtp/server.js";
import { FileSpool } from "../src/spool/file-spool.js";
import { createTempDirectory, removeTempDirectory, DAY_MS, NOW, TEST_DOMAIN } from "./helpers.js";
import { createTestAlias } from "./mail-helpers.js";
import { TestLineClient } from "./support.js";

const servers: Array<{ close: (callback: () => void) => void }> = [];
const tempDirectories: string[] = [];
let db: SqliteDatabase;

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()!.close(() => {});
  }
  db?.close();
  while (tempDirectories.length > 0) {
    removeTempDirectory(tempDirectories.pop()!);
  }
});

async function startLmtp(
  sink: LmtpMessageSink,
  options: { maxMessageBytes?: number } = {},
): Promise<number> {
  const server = createLmtpServer({
    proxy: sink,
    hostname: "wickmail.test",
    localDomains: [TEST_DOMAIN],
    now: () => NOW,
    ...(options.maxMessageBytes !== undefined ? { maxMessageBytes: options.maxMessageBytes } : {}),
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}

function realProxy(): { proxy: MailProxy; spool: FileSpool } {
  db = openDatabase({ path: ":memory:" });
  migrate(db, migrations);
  const directory = createTempDirectory();
  tempDirectories.push(directory);
  const spool = new FileSpool({ directory: join(directory, "spool") });
  const proxy = new MailProxy({
    db,
    spool,
    localDomains: [TEST_DOMAIN],
    primaryAddresses: ["me@example.com"],
  });
  return { proxy, spool };
}

describe("LMTP server", () => {
  it("greets with a 220 and advertises capabilities on LHLO", async () => {
    const port = await startLmtp({
      deliver: async () => ({
        status: "accepted",
        messageId: "m",
        route: "Inbox",
        aliasIds: [],
        primaryReceived: false,
        crossCheck: { envelope: [], visible: [], envelopeOnly: [], visibleOnly: [] },
      }),
    });
    const client = await TestLineClient.connect(port);
    expect((await client.readLine()).startsWith("220 wickmail.test")).toBe(true);
    client.write("LHLO client.example\r\n");
    const reply = await client.readReply();
    expect(TestLineClient.status(reply)).toBe(250);
    expect(reply.join("\n")).toContain("SIZE");
    client.end();
  });

  it("accepts a message, strips spoofed headers, and spools trusted headers", async () => {
    const { proxy, spool } = realProxy();
    const alias = createTestAlias(db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
    });
    const port = await startLmtp(proxy);
    const client = await TestLineClient.connect(port);
    await client.readLine();

    client.write("LHLO client.example\r\n");
    await client.readReply();
    client.write("MAIL FROM:<sender@example.net>\r\n");
    expect(TestLineClient.status(await client.readReply())).toBe(250);
    client.write("RCPT TO:<green.farm@example.com>\r\n");
    expect(TestLineClient.status(await client.readReply())).toBe(250);
    client.write("DATA\r\n");
    expect(TestLineClient.status(await client.readReply())).toBe(354);
    client.write(
      [
        "X-Wickmail-Route: Inbox",
        "X-Wickmail-Message-ID: spoofed",
        "From: sender@example.net",
        "Subject: Hello",
        "",
        "Body",
        ".",
        "",
      ].join("\r\n"),
    );
    const dataReply = await client.readReply();
    expect(TestLineClient.status(dataReply)).toBe(250);
    expect(dataReply.join(" ")).toContain("queued as");
    client.write("QUIT\r\n");
    await client.readReply();

    const spooled = await spool.list();
    expect(spooled).toHaveLength(1);
    const raw = spooled[0]!.raw;
    expect(raw).not.toContain("spoofed");
    expect(raw).toContain(`X-Wickmail-Alias-ID: ${alias.id}`);
    expect(raw).toContain("X-Wickmail-Route: Inbox");
    expect(raw).toContain("Body");
    client.end();
  });

  it("rejects a recipient outside the local domains at RCPT", async () => {
    const { proxy } = realProxy();
    const port = await startLmtp(proxy);
    const client = await TestLineClient.connect(port);
    await client.readLine();
    client.write("LHLO client.example\r\n");
    await client.readReply();
    client.write("MAIL FROM:<sender@example.net>\r\n");
    await client.readReply();
    client.write("RCPT TO:<user@elsewhere.test>\r\n");
    expect(TestLineClient.status(await client.readReply())).toBe(550);
    client.end();
  });

  it("requires RCPT before DATA", async () => {
    const { proxy } = realProxy();
    const port = await startLmtp(proxy);
    const client = await TestLineClient.connect(port);
    await client.readLine();
    client.write("LHLO client.example\r\n");
    await client.readReply();
    client.write("MAIL FROM:<sender@example.net>\r\n");
    await client.readReply();
    client.write("DATA\r\n");
    expect(TestLineClient.status(await client.readReply())).toBe(503);
    client.end();
  });

  it("returns a temporary failure when the proxy cannot accept", async () => {
    const port = await startLmtp({
      deliver: async () => ({ status: "tempfail", reason: "spool unavailable" }),
    });
    const client = await TestLineClient.connect(port);
    await client.readLine();
    client.write("LHLO client.example\r\n");
    await client.readReply();
    client.write("MAIL FROM:<sender@example.net>\r\n");
    await client.readReply();
    client.write("RCPT TO:<green.farm@example.com>\r\n");
    await client.readReply();
    client.write("DATA\r\n");
    await client.readReply();
    client.write("From: a@b.example\r\n\r\nbody\r\n.\r\n");
    const reply = await client.readReply();
    expect(TestLineClient.status(reply)).toBe(451);
    expect(reply.join(" ")).toContain("spool unavailable");
    client.end();
  });

  it("rejects an oversized message with 552", async () => {
    const { proxy } = realProxy();
    createTestAlias(db, { address: "green.farm@example.com", expiresAt: null });
    const port = await startLmtp(proxy, { maxMessageBytes: 16 });
    const client = await TestLineClient.connect(port);
    await client.readLine();
    client.write("LHLO client.example\r\n");
    await client.readReply();
    client.write("MAIL FROM:<sender@example.net>\r\n");
    await client.readReply();
    client.write("RCPT TO:<green.farm@example.com>\r\n");
    await client.readReply();
    client.write("DATA\r\n");
    await client.readReply();
    client.write("From: a@b.example\r\n\r\nthis body is far too long\r\n.\r\n");
    expect(TestLineClient.status(await client.readReply())).toBe(552);
    client.end();
  });
});
