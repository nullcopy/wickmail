/**
 * Alias list presentation logic.
 *
 * Filtering and sorting operate on raw fields the server already computed
 * (`state`, `expiresAt`, `lastUsedAt`, `createdAt`). Nothing here evaluates a
 * lease or derives a state; `state` is always the server's value.
 */

import type { Alias, AliasState, QuarantineResponse } from "@wickmail/core";

/** Sort keys offered by the dashboard. */
export type AliasSortKey = "expires" | "lastUsed" | "created";

/** Expiry filters offered by the dashboard. */
export type ExpiryFilter =
  | { kind: "any" }
  | { kind: "none" }
  | { kind: "within"; seconds: number }
  | { kind: "range"; from: string; to: string };

/** Active dashboard filters. */
export interface AliasFilters {
  search: string;
  states: AliasState[];
  expiry: ExpiryFilter;
}

/** The default filter set: everything, sorted by soonest expiry. */
export function defaultFilters(): AliasFilters {
  return { search: "", states: [], expiry: { kind: "any" } };
}

function time(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Sorts aliases by `key`.
 *
 * Expiry shows the soonest first and places aliases without expiry last.
 * Recently-used and recently-created show the latest first. Ties break on the
 * stable alias id so ordering is deterministic.
 */
export function sortAliases(aliases: readonly Alias[], key: AliasSortKey): Alias[] {
  const copy = [...aliases];
  copy.sort((left, right) => {
    if (key === "expires") {
      const a = time(left.expiresAt);
      const b = time(right.expiresAt);
      if (a === null && b === null) return left.id.localeCompare(right.id);
      if (a === null) return 1;
      if (b === null) return -1;
      return a - b || left.id.localeCompare(right.id);
    }
    const field = key === "lastUsed" ? "lastUsedAt" : "createdAt";
    const a = time(left[field]) ?? 0;
    const b = time(right[field]) ?? 0;
    return b - a || left.id.localeCompare(right.id);
  });
  return copy;
}

function matchesSearch(alias: Alias, needle: string): boolean {
  const query = needle.trim().toLowerCase();
  if (!query) return true;
  return (
    alias.address.toLowerCase().includes(query) ||
    (alias.label?.toLowerCase().includes(query) ?? false) ||
    (alias.purpose?.toLowerCase().includes(query) ?? false)
  );
}

function matchesExpiry(alias: Alias, filter: ExpiryFilter, now: number): boolean {
  switch (filter.kind) {
    case "any":
      return true;
    case "none":
      return alias.expiresAt === null;
    case "within": {
      const expiry = time(alias.expiresAt);
      return expiry !== null && expiry <= now + filter.seconds * 1000;
    }
    case "range": {
      const expiry = time(alias.expiresAt);
      if (expiry === null) return false;
      const from = time(filter.from);
      const to = time(filter.to);
      return (from === null || expiry >= from) && (to === null || expiry <= to);
    }
  }
}

/** Applies search, state, and expiry filters. */
export function filterAliases(
  aliases: readonly Alias[],
  filters: AliasFilters,
  now: Date | number = Date.now(),
): Alias[] {
  const nowMs = typeof now === "number" ? now : now.getTime();
  return aliases.filter((alias) => {
    if (filters.states.length > 0 && !filters.states.includes(alias.state)) return false;
    if (!matchesExpiry(alias, filters.expiry, nowMs)) return false;
    return matchesSearch(alias, filters.search);
  });
}

/** Dashboard summary counts. */
export interface AliasCounts {
  active: number;
  expiringSoon: number;
  expired: number;
  disabled: number;
}

/**
 * Counts aliases by server-computed state.
 *
 * `expiringSoon` counts active aliases whose expiry is at or before
 * `now + threshold`, which is the only place the threshold is applied.
 */
export function aliasCounts(
  aliases: readonly Alias[],
  expiringSoonSeconds: number,
  now: Date | number = Date.now(),
): AliasCounts {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const counts: AliasCounts = { active: 0, expiringSoon: 0, expired: 0, disabled: 0 };
  for (const alias of aliases) {
    if (alias.state === "active") {
      counts.active += 1;
      const expiry = time(alias.expiresAt);
      if (expiry !== null && expiry <= nowMs + expiringSoonSeconds * 1000) {
        counts.expiringSoon += 1;
      }
    } else if (alias.state === "expired") {
      counts.expired += 1;
    } else if (alias.state === "disabled") {
      counts.disabled += 1;
    }
  }
  return counts;
}

/** The number of live quarantined messages per alias id. */
export function quarantineCounts(items: readonly QuarantineResponse[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.status !== "quarantined") continue;
    for (const aliasId of item.aliasIds) {
      counts.set(aliasId, (counts.get(aliasId) ?? 0) + 1);
    }
  }
  return counts;
}
