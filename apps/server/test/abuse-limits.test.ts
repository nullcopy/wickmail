import { afterEach, describe, expect, it } from "vitest";
import {
  alertDiskFull,
  checkDiskSpace,
  isDiskFullError,
  MemoryAlertSink,
} from "../src/abuse/disk.js";
import {
  DEFAULT_MAX_MESSAGE_BYTES,
  defaultAbuseLimits,
  toQuarantineQuota,
} from "../src/abuse/limits.js";
import { SlidingWindowRateLimiter } from "../src/abuse/rateLimit.js";
import { listQuarantineEntries } from "../src/quarantine/repository.js";
import { QuarantineService } from "../src/quarantine/service.js";
import { defaultQuarantineRetentionPolicy } from "../src/quarantine/types.js";
import { MailProxy } from "../src/lmtp/proxy.js";
import { SpoolFullError, type Spool } from "../src/spool/types.js";
import type { SqliteDatabase } from "../src/db/database.js";
import { createApiHarness, type ApiHarness } from "./api-helpers.js";
import { createTestDatabase, NOW } from "./helpers.js";
import { createTestAlias } from "./mail-helpers.js";
import { FakeMailStore } from "../src/mailstore/fake.js";
import { seedQuarantinedMessage } from "./quarantine-helpers.js";

let harness: ApiHarness;
let db: SqliteDatabase | undefined;

afterEach(async () => {
  await harness?.close();
  db?.close();
  db = undefined;
});

describe("sliding-window rate limiter", () => {
  it("admits events up to the limit and denies the next one", () => {
    let clock = NOW;
    const limiter = new SlidingWindowRateLimiter({ now: () => clock });
    expect(limiter.check("k", 2, 60_000).allowed).toBe(true);
    expect(limiter.check("k", 2, 60_000).allowed).toBe(true);
    const denied = limiter.check("k", 2, 60_000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);

    clock += 60_001;
    expect(limiter.check("k", 2, 60_000).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const limiter = new SlidingWindowRateLimiter({ now: () => NOW });
    expect(limiter.check("a", 1, 60_000).allowed).toBe(true);
    expect(limiter.check("b", 1, 60_000).allowed).toBe(true);
    expect(limiter.check("a", 1, 60_000).allowed).toBe(false);
  });
});

describe("disk-full handling", () => {
  it("reports free space and tolerates an unreadable path", () => {
    const status = checkDiskSpace("/tmp", 0);
    expect(status.ok).toBe(true);
    expect(status.freeBytes).toBeGreaterThan(0);

    const missing = checkDiskSpace("/nonexistent-wickmail-path", 1024);
    expect(missing.ok).toBe(true);
    expect(missing.error).toBeDefined();
  });

  it("recognizes ENOSPC and alerts without dropping mail", () => {
    expect(isDiskFullError({ code: "ENOSPC" })).toBe(true);
    expect(isDiskFullError(new Error("other"))).toBe(false);

    const sink = new MemoryAlertSink();
    alertDiskFull(sink, NOW, { spool: "/var/lib/wickmail/spool" });
    const alerts = sink.ofKind("disk_full");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.message).toContain("deferred");
  });
});

describe("abuse limits", () => {
  it("uses the documented defaults and maps quarantine quotas", () => {
    const limits = defaultAbuseLimits();
    expect(limits.maxMessageBytes).toBe(DEFAULT_MAX_MESSAGE_BYTES);
    expect(limits.rateLimits.inboundPerSenderPerMinute).toBeGreaterThan(0);
    const quota = toQuarantineQuota(limits);
    expect(quota.maxMessages).toBe(limits.quarantine.maxMessages);
    expect(quota.maxBytes).toBe(limits.quarantine.maxBytes);
  });

  it("rate limits management authentication", async () => {
    const limits = defaultAbuseLimits();
    limits.rateLimits.authPerMinute = 1;
    harness = await createApiHarness({ limits });
    const first = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: "admin", password: harness.password },
    });
    expect(first.statusCode).toBe(200);
    const second = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: "admin", password: harness.password },
    });
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
  });

  it("deletes the oldest quarantined messages first when a quota is exceeded", async () => {
    db = createTestDatabase();
    const store = new FakeMailStore();
    const quarantine = new QuarantineService({
      db,
      store,
      now: () => NOW,
      policy: { ...defaultQuarantineRetentionPolicy(), quota: { maxMessages: 2 } },
    });
    const alias = createTestAlias(db, { address: "quota@example.com", expiresAt: null });
    seedQuarantinedMessage(db, store, {
      messageId: "oldest",
      aliasIds: [alias.id],
      receivedAt: NOW - 3000,
    });
    seedQuarantinedMessage(db, store, {
      messageId: "middle",
      aliasIds: [alias.id],
      receivedAt: NOW - 2000,
    });
    seedQuarantinedMessage(db, store, {
      messageId: "newest",
      aliasIds: [alias.id],
      receivedAt: NOW - 1000,
    });

    await quarantine.runRetention();
    const remaining = listQuarantineEntries(db, { status: "quarantined" }).map(
      (entry) => entry.messageId,
    );
    expect(remaining).toEqual(["middle", "newest"]);
    expect(await store.getMessageIn("Aliases/Expired", "oldest")).toBeUndefined();
  });
});

describe("mail-path abuse controls", () => {
  function memorySpool(overrides: Partial<Spool> = {}): Spool {
    return {
      async enqueue() {},
      async list() {
        return [];
      },
      async get() {
        return undefined;
      },
      async remove() {},
      async recordAttempt() {},
      async stats() {
        return { depth: 0, oldestAgeMs: null };
      },
      ...overrides,
    };
  }

  it("returns a temporary failure and alerts when the spool is full", async () => {
    db = createTestDatabase();
    const sink = new MemoryAlertSink();
    const proxy = new MailProxy({
      db,
      spool: memorySpool({
        async enqueue() {
          throw new SpoolFullError("spool filesystem is full");
        },
      }),
      localDomains: ["example.com"],
      primaryAddresses: ["me@example.com"],
      now: () => NOW,
      alerts: sink,
    });
    const result = await proxy.deliver({
      mailFrom: "sender@example.net",
      rcptTo: ["me@example.com"],
      data: "Subject: hi\r\n\r\nbody",
      receivedAt: NOW,
    });
    expect(result.status).toBe("tempfail");
    expect(sink.ofKind("disk_full")).toHaveLength(1);
  });

  it("rate limits inbound mail per sender and globally", async () => {
    db = createTestDatabase();
    const limiter = new SlidingWindowRateLimiter({ now: () => NOW });
    const proxy = new MailProxy({
      db,
      spool: memorySpool(),
      localDomains: ["example.com"],
      primaryAddresses: ["me@example.com"],
      now: () => NOW,
      rateLimiter: limiter,
      rateLimits: { globalPerMinute: 10, perSenderPerMinute: 1 },
    });

    const first = await proxy.deliver({
      mailFrom: "sender@example.net",
      rcptTo: ["me@example.com"],
      data: "Subject: one\r\n\r\nbody",
      receivedAt: NOW,
    });
    expect(first.status).toBe("accepted");

    const second = await proxy.deliver({
      mailFrom: "sender@example.net",
      rcptTo: ["me@example.com"],
      data: "Subject: two\r\n\r\nbody",
      receivedAt: NOW,
    });
    expect(second.status).toBe("tempfail");
  });
});
