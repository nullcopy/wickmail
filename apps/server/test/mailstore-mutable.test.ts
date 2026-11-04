import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeMailStore } from "../src/mailstore/fake.js";
import { FileMailStore } from "../src/mailstore/filesystem.js";
import { createTempDirectory, removeTempDirectory, NOW } from "./helpers.js";

const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    removeTempDirectory(tempDirectories.pop()!);
  }
});

function fileStore(): FileMailStore {
  const directory = createTempDirectory();
  tempDirectories.push(directory);
  return new FileMailStore({ directory: join(directory, "mail") });
}

async function exerciseMutable(store: FakeMailStore | FileMailStore): Promise<void> {
  store.put("Aliases/Expired", "m1", "From: a@b.example\r\n\r\nbody", NOW);

  expect((await store.getMessageIn("Aliases/Expired", "m1"))?.messageId).toBe("m1");
  expect(await store.getMessageIn("Inbox", "m1")).toBeUndefined();

  const locator = await store.copyMessage("m1", "Inbox");
  expect(locator?.mailbox).toBe("Inbox");
  expect((await store.getMessageIn("Inbox", "m1"))?.raw).toContain("body");

  // Copying again is idempotent.
  const again = await store.copyMessage("m1", "Inbox");
  expect(again?.mailbox).toBe("Inbox");
  expect(await store.listMessages("Inbox")).toHaveLength(1);

  await store.deleteMessage("Aliases/Expired", "m1");
  expect(await store.getMessageIn("Aliases/Expired", "m1")).toBeUndefined();
  expect(await store.getMessageIn("Inbox", "m1")).toBeDefined();

  // Deleting again is idempotent.
  await store.deleteMessage("Aliases/Expired", "m1");

  expect(await store.copyMessage("missing", "Inbox")).toBeUndefined();
}

describe("mutable mail store", () => {
  it("supports copy and delete on the fake store", async () => {
    await exerciseMutable(new FakeMailStore());
  });

  it("supports copy and delete on the filesystem store", async () => {
    await exerciseMutable(fileStore());
  });
});
