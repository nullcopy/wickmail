import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readMessageByIdentity, type MailStoreLogger } from "../src/mailstore/adapter.js";
import { FakeMailStore } from "../src/mailstore/fake.js";
import { FileMailStore } from "../src/mailstore/filesystem.js";
import { createTempDirectory, removeTempDirectory, NOW } from "./helpers.js";

const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    removeTempDirectory(tempDirectories.pop()!);
  }
});

function fileStore(logger?: MailStoreLogger): FileMailStore {
  const directory = createTempDirectory();
  tempDirectories.push(directory);
  return new FileMailStore({ directory: join(directory, "mail"), ...(logger ? { logger } : {}) });
}

describe("FileMailStore", () => {
  it("lists mailboxes and messages and reads by identity", async () => {
    const store = fileStore();
    store.put("Inbox", "m1", "From: a@b.example\r\n\r\nfirst", NOW);
    store.put("Inbox", "m2", "From: a@b.example\r\n\r\nsecond", NOW + 1);
    store.put("Aliases/Expired", "m3", "From: a@b.example\r\n\r\nthird", NOW + 2);

    expect(await store.listMailboxes()).toEqual(["Aliases/Expired", "Inbox"]);
    expect((await store.listMessages("Inbox")).map((message) => message.messageId)).toEqual([
      "m1",
      "m2",
    ]);
    expect((await store.getMessage("m3"))?.mailbox).toBe("Aliases/Expired");
    expect(await store.getMessage("missing")).toBeUndefined();
  });

  it("reads a message by its cached locator", async () => {
    const store = fileStore();
    const locator = store.put("Inbox", "m1", "body", NOW);
    const message = await store.getMessageByLocator(locator);
    expect(message?.messageId).toBe("m1");
    expect(message?.raw).toBe("body");
  });

  it("never treats a locator as identity", async () => {
    const store = fileStore();
    const locator = store.put("Inbox", "m1", "first", NOW);
    store.put("Inbox", "m2", "second", NOW + 1);

    // The locator still points at m1, so a lookup for m2 falls back to identity.
    const viaStaleLocator = await readMessageByIdentity(store, "m2", locator);
    expect(viaStaleLocator?.messageId).toBe("m2");
    expect(viaStaleLocator?.raw).toBe("second");
  });

  it("returns undefined for a locator that no longer resolves", async () => {
    const store = fileStore();
    store.put("Inbox", "m1", "body", NOW);
    expect(await store.getMessageByLocator({ mailbox: "Inbox", uidValidity: 1, uid: 999 })).toBe(
      undefined,
    );
  });

  it("never logs message bodies", async () => {
    const records: string[] = [];
    const logger: MailStoreLogger = {
      debug: (message, context) => records.push(`${message} ${JSON.stringify(context ?? {})}`),
      info: (message, context) => records.push(`${message} ${JSON.stringify(context ?? {})}`),
      warn: (message, context) => records.push(`${message} ${JSON.stringify(context ?? {})}`),
      error: (message, context) => records.push(`${message} ${JSON.stringify(context ?? {})}`),
    };
    const store = fileStore(logger);
    const body = "super-secret-message-body";
    const locator = store.put("Inbox", "m1", `From: a@b.example\r\n\r\n${body}`, NOW);
    await store.getMessage("m1");
    await store.getMessageByLocator(locator);
    await store.listMessages("Inbox");
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record).not.toContain(body);
    }
  });
});

describe("FakeMailStore", () => {
  it("behaves like the filesystem adapter", async () => {
    const store = new FakeMailStore();
    const locator = store.put("Aliases/Expired", "m1", "body", NOW);
    expect(await store.listMailboxes()).toEqual(["Aliases/Expired"]);
    expect((await store.getMessage("m1"))?.messageId).toBe("m1");
    expect((await store.getMessageByLocator(locator))?.messageId).toBe("m1");
    expect(await readMessageByIdentity(store, "m1", locator)).toMatchObject({ messageId: "m1" });
  });
});
