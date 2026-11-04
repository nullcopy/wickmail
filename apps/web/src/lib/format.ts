import type { Alias, AliasState, LeasePolicy } from "wickmail-core";

/** One minute, in milliseconds. */
export const MINUTE_MS = 60_000;
/** One hour, in milliseconds. */
export const HOUR_MS = 60 * MINUTE_MS;
/** One day, in milliseconds. */
export const DAY_MS = 24 * HOUR_MS;

/** Format a duration in seconds as a short human-readable phrase. */
export function formatDuration(seconds: number): string {
  if (seconds % DAY_MS_SECONDS === 0) {
    const days = seconds / DAY_MS_SECONDS;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

const DAY_MS_SECONDS = 24 * 60 * 60;

/** A coarse relative-time phrase. `now` is epoch milliseconds. */
export function formatRelativeTime(iso: string | null, now: number): string {
  if (iso === null) {
    return "never";
  }
  const target = Date.parse(iso);
  if (Number.isNaN(target)) {
    return "unknown";
  }
  const diff = target - now;
  const magnitude = Math.abs(diff);
  const suffix = diff < 0 ? "ago" : "in";
  if (magnitude < MINUTE_MS) {
    return diff < 0 ? "just now" : "in a moment";
  }
  const units: Array<[number, string]> = [
    [DAY_MS, "day"],
    [HOUR_MS, "hour"],
    [MINUTE_MS, "minute"],
  ];
  for (const [size, label] of units) {
    if (magnitude >= size) {
      const value = Math.round(magnitude / size);
      const plural = value === 1 ? label : `${label}s`;
      return diff < 0 ? `${value} ${plural} ago` : `in ${value} ${plural}`;
    }
  }
  return "just now";
}

/** Format an exact UTC timestamp for display alongside a relative phrase. */
export function formatExact(iso: string | null): string {
  if (iso === null) {
    return "No expiry";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

/** Format a date-only value for a form input (`YYYY-MM-DD`). */
export function toDateInputValue(iso: string | null): string {
  if (iso === null) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Explain an alias's effective state and expiry in human terms. The state is
 * the server-computed value; only the wording is derived here.
 */
export function describeState(alias: Pick<Alias, "state" | "expiresAt">, now: number): string {
  switch (alias.state) {
    case "disabled":
      return "Disabled — inbound mail is rejected and outbound is blocked";
    case "expired":
      return alias.expiresAt === null
        ? "Expired"
        : `Expired ${formatRelativeTime(alias.expiresAt, now)}`;
    case "active":
      if (alias.expiresAt === null) {
        return "Active — no expiry";
      }
      return `Expires ${formatRelativeTime(alias.expiresAt, now)}`;
  }
}

/** Human label for an effective state. */
export function stateLabel(state: AliasState): string {
  switch (state) {
    case "active":
      return "Active";
    case "expired":
      return "Expired";
    case "disabled":
      return "Disabled";
  }
}

/** Describe the renewal behavior stored in an alias's lease policy. */
export function describeRenewal(policy: LeasePolicy): string {
  return policy.renewOnOutbound
    ? `Renews on outbound mail (${formatDuration(policy.leaseDurationSeconds)})`
    : "Does not renew on outbound mail";
}

/**
 * The time an alias was last used: the later of inbound mail and user
 * activity, falling back to creation time when neither exists.
 */
export function lastUsedAt(alias: Alias): string {
  const values = [alias.lastInboundAt, alias.lastUserActivityAt].filter(
    (value): value is string => value !== null,
  );
  if (values.length === 0) {
    return alias.createdAt;
  }
  return values.reduce((latest, value) =>
    Date.parse(value) > Date.parse(latest) ? value : latest,
  );
}
