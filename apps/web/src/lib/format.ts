/**
 * Time and size formatting for the management UI.
 *
 * These helpers format raw server timestamps for display. They never derive
 * lease state: `alias.state` is the server's decision.
 */

import type { Alias } from "@wickmail/core";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The milliseconds for a raw ISO timestamp, or NaN when unparseable. */
export function parseTime(iso: string): number {
  return Date.parse(iso);
}

/**
 * Formats an instant relative to `now`, such as `in 3 days` or `2 hours ago`.
 *
 * Relative times are paired with exact timestamps elsewhere in the UI.
 */
export function formatRelative(iso: string, now: Date | number = Date.now()): string {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const target = parseTime(iso);
  if (Number.isNaN(target)) return "unknown";
  const diff = target - nowMs;
  const abs = Math.abs(diff);
  if (abs < 45 * SECOND) return "just now";

  let value: number;
  let unit: string;
  if (abs < HOUR) {
    value = Math.round(abs / MINUTE);
    unit = "minute";
  } else if (abs < DAY) {
    value = Math.round(abs / HOUR);
    unit = "hour";
  } else if (abs < 30 * DAY) {
    value = Math.round(abs / DAY);
    unit = "day";
  } else if (abs < 365 * DAY) {
    value = Math.round(abs / (30 * DAY));
    unit = "month";
  } else {
    value = Math.round(abs / (365 * DAY));
    unit = "year";
  }
  const label = `${value} ${unit}${value === 1 ? "" : "s"}`;
  return diff >= 0 ? `in ${label}` : `${label} ago`;
}

/** Formats an instant as an exact local timestamp. */
export function formatAbsolute(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A human-readable summary of an alias's state and expiry. */
export function describeAlias(alias: Alias, now: Date | number = Date.now()): string {
  if (alias.state === "disabled") {
    return "Disabled";
  }
  if (alias.state === "expired") {
    return alias.expiresAt ? `Expired ${formatRelative(alias.expiresAt, now)}` : "Expired";
  }
  if (!alias.expiresAt) {
    return "No expiry";
  }
  return `Expires ${formatRelative(alias.expiresAt, now)}`;
}

/** A short duration label for a lease length in seconds. */
export function formatDuration(seconds: number): string {
  const secondsPerHour = 3600;
  const secondsPerDay = 24 * secondsPerHour;
  if (seconds <= 0) return "no time";
  if (seconds % secondsPerDay === 0) {
    const days = seconds / secondsPerDay;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (seconds % secondsPerHour === 0) {
    const hours = seconds / secondsPerHour;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** A byte count for quarantine sizes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The plural suffix for a count. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}
