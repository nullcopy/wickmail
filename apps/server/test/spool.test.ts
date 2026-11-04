import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FlakyDeliveryTarget, RecordingDeliveryTarget } from "../src/delivery/target.js";
import { classifySpoolError, FileSpool } from "../src/spool/file-spool.js";
import {
  SpoolFullError,
  SpoolUnavailableError,
  type NewSpooledMessage,
} from "../src/spool/types.js";
import { SpoolWorker } from "../src/spool/worker.js";
import { createTempDirectory, removeTempDirectory, NOW } from "./helpers.js";

const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    removeTempDirectory(tempDirectories.pop()!);
  }
});

function spool(): FileSpool {
  const directory = createTempDirectory();
  tempDirectories.push(directory);
  return new FileSpool({ directory: join(directory, "spool") });
}

function message(overrides: Partial<NewSpooledMessage> = {}): NewSpooledMessage {
  return {
    id: "018f0d9c-0000-7000-8000-000000000000",
    mailFrom: "sender@example.net",
    rcptTo: ["green.farm@example.com"],
    route: "Inbox",
    aliasIds: [],
    primaryReceived: false,
    receivedAt: NOW,
    raw: "X-Wickmail-Route: Inbox\r\nFrom: sender@example.net\r\n\r\nbody",
    ...overrides,
  };
}

describe("FileSpool", () => {
  it("stores a message durably before it is acknowledged", async () => {
    const directory = createTempDirectory();
    tempDirectories.push(directory);
    const store = new FileSpool({ directory: join(directory, "spool") });
    await store.enqueue(message());

    // A fresh instance reads the message from disk.
    const reopened = new FileSpool({ directory: join(directory, "spool") });
    const listed = await reopened.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(message().id);
    expect(listed[0]!.raw).toContain("X-Wickmail-Route: Inbox");
  });

  it("gets and removes a message", async () => {
    const store = spool();
    await store.enqueue(message());
    expect((await store.get(message().id))?.mailFrom).toBe("sender@example.net");
    await store.remove(message().id);
    expect(await store.get(message().id)).toBeUndefined();
    expect(await store.list()).toHaveLength(0);
  });

  it("reports depth and age for monitoring", async () => {
    const store = spool();
    expect(await store.stats(NOW)).toEqual({ depth: 0, oldestAgeMs: null });
    await store.enqueue(
      message({ id: "018f0d9c-0000-7000-8000-000000000001", receivedAt: NOW - 5000 }),
    );
    await store.enqueue(
      message({ id: "018f0d9c-0000-7000-8000-000000000002", receivedAt: NOW - 1000 }),
    );
    expect(await store.stats(NOW)).toEqual({ depth: 2, oldestAgeMs: 5000 });
  });

  it("records a failed attempt and schedules the next", async () => {
    const store = spool();
    await store.enqueue(message());
    await store.recordAttempt(message().id, "downstream down", NOW + 1000);
    const stored = await store.get(message().id);
    expect(stored?.attempts).toBe(1);
    expect(stored?.lastError).toBe("downstream down");
    expect(stored?.nextAttemptAt).toBe(NOW + 1000);
  });

  it("classifies a full filesystem as a full-spool error", () => {
    expect(classifySpoolError({ code: "ENOSPC" })).toBeInstanceOf(SpoolFullError);
    expect(classifySpoolError(new Error("boom"))).toBeInstanceOf(SpoolUnavailableError);
  });

  it("throws a temporary spool error when the spool cannot be created", () => {
    const directory = createTempDirectory();
    tempDirectories.push(directory);
    const file = join(directory, "not-a-directory");
    writeFileSync(file, "x");
    expect(() => new FileSpool({ directory: join(file, "spool") })).toThrow(SpoolUnavailableError);
  });
});

describe("SpoolWorker", () => {
  it("delivers and removes a message", async () => {
    const store = spool();
    await store.enqueue(message());
    const target = new RecordingDeliveryTarget();
    const worker = new SpoolWorker(store, target, { now: () => NOW });
    expect(await worker.runOnce()).toEqual({ delivered: 1, retried: 0 });
    expect(target.delivered).toHaveLength(1);
    expect(await store.list()).toHaveLength(0);
  });

  it("keeps a message and retries it without bouncing", async () => {
    const store = spool();
    await store.enqueue(message());
    const target = new FlakyDeliveryTarget(1);
    let clock = NOW;
    const worker = new SpoolWorker(store, target, {
      now: () => clock,
      backoffMs: () => 1000,
    });

    expect(await worker.runOnce()).toEqual({ delivered: 0, retried: 1 });
    expect(await store.list()).toHaveLength(1);
    expect(target.delivered).toHaveLength(0);

    // The retry is not due yet.
    expect(await worker.runOnce()).toEqual({ delivered: 0, retried: 0 });

    clock += 1000;
    expect(await worker.runOnce()).toEqual({ delivered: 1, retried: 0 });
    expect(target.delivered).toHaveLength(1);
    expect(await store.list()).toHaveLength(0);
  });
});
