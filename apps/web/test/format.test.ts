import { describe, expect, it } from "vitest";
import {
  describeRenewal,
  describeState,
  formatDuration,
  formatExact,
  formatRelativeTime,
  lastUsedAt,
} from "../src/lib/format.js";
import { DAY_MS, NOW, makeAlias } from "./helpers.js";

describe("formatRelativeTime", () => {
  it("describes past and future times", () => {
    expect(formatRelativeTime(new Date(NOW - 3 * DAY_MS).toISOString(), NOW)).toBe("3 days ago");
    expect(formatRelativeTime(new Date(NOW + 2 * 60 * 60 * 1000).toISOString(), NOW)).toBe(
      "in 2 hours",
    );
    expect(formatRelativeTime(null, NOW)).toBe("never");
  });
});

describe("formatDuration", () => {
  it("uses the largest whole unit", () => {
    expect(formatDuration(7 * 24 * 60 * 60)).toBe("7 days");
    expect(formatDuration(24 * 60 * 60)).toBe("1 day");
    expect(formatDuration(90 * 60)).toBe("90 minutes");
  });
});

describe("formatExact", () => {
  it("renders a UTC timestamp", () => {
    expect(formatExact("2026-11-03T12:00:00.000Z")).toBe("2026-11-03 12:00:00 UTC");
    expect(formatExact(null)).toBe("No expiry");
  });
});

describe("describeState", () => {
  it("explains each effective state", () => {
    expect(describeState({ state: "active", expiresAt: null }, NOW)).toBe("Active — no expiry");
    expect(
      describeState({ state: "active", expiresAt: new Date(NOW + DAY_MS).toISOString() }, NOW),
    ).toBe("Expires in 1 day");
    expect(
      describeState({ state: "expired", expiresAt: new Date(NOW - DAY_MS).toISOString() }, NOW),
    ).toBe("Expired 1 day ago");
    expect(describeState({ state: "disabled", expiresAt: null }, NOW)).toMatch(/Disabled/);
  });
});

describe("describeRenewal", () => {
  it("states whether outbound mail renews", () => {
    expect(describeRenewal({ leaseDurationSeconds: 604800, renewOnOutbound: true })).toMatch(
      /Renews on outbound/,
    );
    expect(describeRenewal({ leaseDurationSeconds: 604800, renewOnOutbound: false })).toMatch(
      /Does not renew/,
    );
  });
});

describe("lastUsedAt", () => {
  it("takes the later of inbound and user activity, falling back to creation", () => {
    const created = new Date(NOW - 10 * DAY_MS).toISOString();
    const inbound = new Date(NOW - 3 * DAY_MS).toISOString();
    const activity = new Date(NOW - DAY_MS).toISOString();
    expect(
      lastUsedAt(
        makeAlias({ createdAt: created, lastInboundAt: inbound, lastUserActivityAt: activity }),
      ),
    ).toBe(activity);
    expect(
      lastUsedAt(
        makeAlias({ createdAt: created, lastInboundAt: inbound, lastUserActivityAt: null }),
      ),
    ).toBe(inbound);
    expect(
      lastUsedAt(makeAlias({ createdAt: created, lastInboundAt: null, lastUserActivityAt: null })),
    ).toBe(created);
  });
});
