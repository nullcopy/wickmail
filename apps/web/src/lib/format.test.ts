import assert from "node:assert/strict";
import { test } from "node:test";

import { describeAlias, formatBytes, formatDuration, formatRelative, plural } from "./format.ts";
import { makeAlias } from "./testing.ts";

const NOW = Date.parse("2026-01-04T00:00:00Z");

test("formatRelative reports future, past, and immediate instants", () => {
  assert.equal(formatRelative("2026-01-04T00:00:30Z", NOW), "just now");
  assert.equal(formatRelative("2026-01-04T03:00:00Z", NOW), "in 3 hours");
  assert.equal(formatRelative("2026-01-07T00:00:00Z", NOW), "in 3 days");
  assert.equal(formatRelative("2026-01-01T00:00:00Z", NOW), "3 days ago");
  assert.equal(formatRelative("not-a-date", NOW), "unknown");
});

test("formatDuration uses whole days and hours", () => {
  assert.equal(formatDuration(7 * 24 * 60 * 60), "7 days");
  assert.equal(formatDuration(24 * 60 * 60), "1 day");
  assert.equal(formatDuration(60 * 60), "1 hour");
  assert.equal(formatDuration(90), "2 minutes");
});

test("describeAlias reads the server state", () => {
  assert.equal(
    describeAlias(makeAlias({ expiresAt: "2026-01-08T00:00:00Z" }), NOW),
    "Expires in 4 days",
  );
  assert.equal(describeAlias(makeAlias({ state: "disabled" }), NOW), "Disabled");
  assert.equal(
    describeAlias(makeAlias({ state: "expired", expiresAt: "2026-01-01T00:00:00Z" }), NOW),
    "Expired 3 days ago",
  );
  assert.equal(describeAlias(makeAlias({ expiresAt: null }), NOW), "No expiry");
});

test("formatBytes scales units", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
});

test("plural switches on count", () => {
  assert.equal(plural(1, "message"), "message");
  assert.equal(plural(2, "message"), "messages");
});
