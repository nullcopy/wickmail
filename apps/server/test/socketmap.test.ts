import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SqliteDatabase } from "../src/db/database.js";
import { createRecipientPolicy } from "../src/policy/recipient.js";
import {
  createSocketmapServer,
  encodeSocketmapResponse,
  parseSocketmapRequest,
  recipientAccessValue,
} from "../src/policy/socketmap.js";
import {
  createTempDirectory,
  removeTempDirectory,
  createTestDatabase,
  DAY_MS,
  NOW,
  TEST_DOMAIN,
} from "./helpers.js";
import { createTestAlias } from "./mail-helpers.js";
import { TestLineClient } from "./support.js";

const openServers: Array<{ close: (callback: () => void) => void }> = [];
const tempDirectories: string[] = [];
let db: SqliteDatabase;

afterEach(() => {
  while (openServers.length > 0) {
    openServers.pop()!.close(() => {});
  }
  while (tempDirectories.length > 0) {
    removeTempDirectory(tempDirectories.pop()!);
  }
  db?.close();
});

async function startServer(
  evaluate: Parameters<typeof createSocketmapServer>[0]["evaluate"],
): Promise<number> {
  const server = createSocketmapServer({ mapName: "recipient", evaluate });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}

async function lookup(port: number, line: string): Promise<string> {
  const client = await TestLineClient.connect(port);
  client.write(`${line}\n`);
  const response = await client.readLine();
  client.end();
  return response;
}

describe("socketmap protocol", () => {
  it("parses a request with a key that contains spaces", () => {
    expect(parseSocketmapRequest("recipient green.farm@example.com\n")).toEqual({
      map: "recipient",
      key: "green.farm@example.com",
    });
    expect(parseSocketmapRequest("recipient a b c\n")).toEqual({
      map: "recipient",
      key: "a b c",
    });
    expect(parseSocketmapRequest("nospace\n")).toBeUndefined();
  });

  it("encodes responses with and without text", () => {
    expect(encodeSocketmapResponse({ status: "OK", text: "OK" })).toBe("OK OK\n");
    expect(encodeSocketmapResponse({ status: "NOTFOUND", text: "" })).toBe("NOTFOUND\n");
  });

  it("maps decisions to Postfix check_recipient_access values", () => {
    expect(recipientAccessValue({ outcome: "accept", recipient: "primary" })).toBe("OK");
    expect(recipientAccessValue({ outcome: "reject", reason: "unknown" })).toContain("REJECT");
    expect(recipientAccessValue({ outcome: "reject", reason: "disabled" })).toContain("disabled");
    expect(recipientAccessValue({ outcome: "tempfail", reason: "x" })).toContain("DEFER");
  });
});

describe("socketmap server", () => {
  function dbPolicy() {
    db = createTestDatabase();
    createTestAlias(db, { address: "green.farm@example.com", expiresAt: NOW + DAY_MS });
    createTestAlias(db, {
      address: "off.led@example.com",
      expiresAt: NOW + DAY_MS,
      disabledAt: NOW - 1,
    });
    createTestAlias(db, { address: "old.alias@example.com", expiresAt: NOW - DAY_MS });
    return createRecipientPolicy({
      db,
      localDomains: [TEST_DOMAIN],
      primaryAddresses: ["me@example.com"],
    });
  }

  it("accepts an active alias with OK OK", async () => {
    const policy = dbPolicy();
    const port = await startServer((key) => policy.evaluate(key, NOW));
    expect(await lookup(port, "recipient green.farm@example.com")).toBe("OK OK");
  });

  it("accepts an expired alias", async () => {
    const policy = dbPolicy();
    const port = await startServer((key) => policy.evaluate(key, NOW));
    expect(await lookup(port, "recipient old.alias@example.com")).toBe("OK OK");
  });

  it("rejects an unknown recipient permanently", async () => {
    const policy = dbPolicy();
    const port = await startServer((key) => policy.evaluate(key, NOW));
    expect(await lookup(port, "recipient nobody@example.com")).toBe("OK REJECT unknown recipient");
  });

  it("rejects a disabled recipient permanently", async () => {
    const policy = dbPolicy();
    const port = await startServer((key) => policy.evaluate(key, NOW));
    expect(await lookup(port, "recipient off.led@example.com")).toBe(
      "OK REJECT disabled recipient",
    );
  });

  it("returns a temporary failure, never unknown, when policy is unavailable", async () => {
    const port = await startServer(() => {
      throw new Error("database unavailable");
    });
    expect(await lookup(port, "recipient green.farm@example.com")).toBe(
      "TEMP database unavailable",
    );
  });

  it("returns NOTFOUND for an unrelated map", async () => {
    const policy = dbPolicy();
    const port = await startServer((key) => policy.evaluate(key, NOW));
    expect(await lookup(port, "other green.farm@example.com")).toBe("NOTFOUND");
  });

  it("returns PERM for a malformed request", async () => {
    const policy = dbPolicy();
    const port = await startServer((key) => policy.evaluate(key, NOW));
    expect(await lookup(port, "malformed")).toBe("PERM malformed request");
  });

  it("handles multiple requests on one connection", async () => {
    const policy = dbPolicy();
    const port = await startServer((key) => policy.evaluate(key, NOW));
    const client = await TestLineClient.connect(port);
    client.write("recipient green.farm@example.com\nrecipient nobody@example.com\n");
    expect(await client.readLine()).toBe("OK OK");
    expect(await client.readLine()).toBe("OK REJECT unknown recipient");
    client.end();
  });

  it("serves the same policy over a Unix socket", async () => {
    const directory = createTempDirectory();
    tempDirectories.push(directory);
    const socketPath = join(directory, "policy.sock");
    const policy = dbPolicy();
    const server = createSocketmapServer({
      mapName: "recipient",
      evaluate: (key) => policy.evaluate(key, NOW),
    });
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));

    const client = await TestLineClient.connectPath(socketPath);
    client.write("recipient green.farm@example.com\n");
    expect(await client.readLine()).toBe("OK OK");
    client.end();
  });
});
