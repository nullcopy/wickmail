import type {
  Alias,
  AliasSort,
  AliasState,
  ListAliasesQuery,
  QuarantinedMessage,
  SortOrder,
} from "wickmail-core";
import { lastUsedAt } from "./format.js";

/** The expiry filter presets offered on the dashboard. */
export type ExpiryFilter = "any" | "24h" | "7d" | "custom" | "none";

/** The dashboard search, state, and expiry criteria. */
export interface AliasCriteria {
  /** Free-text search over label, purpose, and address. */
  search: string;
  /** The effective state to show, or `all`. */
  state: AliasState | "all";
  /** The expiry window to show. */
  expiry: ExpiryFilter;
  /** The custom window start, as a `YYYY-MM-DD` date. */
  customAfter: string;
  /** The custom window end, as a `YYYY-MM-DD` date. */
  customBefore: string;
}

/** The default dashboard criteria: every alias, soonest expiry first. */
export const DEFAULT_ALIAS_CRITERIA: AliasCriteria = {
  search: "",
  state: "all",
  expiry: "any",
  customAfter: "",
  customBefore: "",
};

/** The default number of aliases fetched per page. */
export const ALIAS_PAGE_SIZE = 200;

/** The sort direction that matches each sort key's intent. */
export function orderForSort(sort: AliasSort): SortOrder {
  return sort === "expires" ? "asc" : "desc";
}

function startOfDayIso(date: string): string {
  return `${date}T00:00:00.000Z`;
}

function endOfDayIso(date: string): string {
  return `${date}T23:59:59.999Z`;
}

/**
 * Derive the `GET /v1/aliases` query for the dashboard criteria.
 *
 * Expiry windows exclude aliases without an expiry, and the "no expiry" filter
 * selects only those aliases. The window is evaluated by the server against
 * the stored `expiresAt`; the client never re-derives lease state.
 */
export function deriveAliasQuery(
  criteria: AliasCriteria,
  sort: AliasSort,
  now: number,
): ListAliasesQuery {
  const query: ListAliasesQuery = {
    sort,
    order: orderForSort(sort),
    limit: ALIAS_PAGE_SIZE,
  };

  const search = criteria.search.trim();
  if (search.length > 0) {
    query.search = search;
  }
  if (criteria.state !== "all") {
    query.state = criteria.state;
  }

  switch (criteria.expiry) {
    case "any":
      break;
    case "none":
      query.hasExpiry = false;
      break;
    case "24h":
      query.hasExpiry = true;
      query.expiresAfter = new Date(now).toISOString();
      query.expiresBefore = new Date(now + 24 * 60 * 60 * 1000).toISOString();
      break;
    case "7d":
      query.hasExpiry = true;
      query.expiresAfter = new Date(now).toISOString();
      query.expiresBefore = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
      break;
    case "custom":
      query.hasExpiry = true;
      if (criteria.customAfter.length > 0) {
        query.expiresAfter = startOfDayIso(criteria.customAfter);
      }
      if (criteria.customBefore.length > 0) {
        query.expiresBefore = endOfDayIso(criteria.customBefore);
      }
      break;
  }

  return query;
}

/** The sort key value for an alias, or `null` when it has none. */
export function aliasSortValue(alias: Alias, sort: AliasSort): number | null {
  switch (sort) {
    case "expires":
      return alias.expiresAt === null ? null : Date.parse(alias.expiresAt);
    case "created":
      return Date.parse(alias.createdAt);
    case "lastUsed":
      // Never-used aliases fall back to their creation time.
      return Date.parse(lastUsedAt(alias));
  }
}

function compareValues(left: number | null, right: number | null, order: SortOrder): number {
  // Aliases without a value sort last in both directions, so paging stays stable.
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return order === "asc" ? left - right : right - left;
}

/**
 * Compare two aliases under a sort key and direction, with a stable ID
 * tiebreak. Mirrors the server's ordering so a client-side view matches the
 * paginated API.
 */
export function compareAliases(
  left: Alias,
  right: Alias,
  sort: AliasSort,
  order: SortOrder,
): number {
  const primary = compareValues(aliasSortValue(left, sort), aliasSortValue(right, sort), order);
  if (primary !== 0) {
    return primary;
  }
  return left.id.localeCompare(right.id);
}

/** Return a new array of aliases in deterministic sort order. */
export function sortAliases(
  aliases: readonly Alias[],
  sort: AliasSort,
  order?: SortOrder,
): Alias[] {
  const direction = order ?? orderForSort(sort);
  return [...aliases].sort((left, right) => compareAliases(left, right, sort, direction));
}

/** Whether an alias is active and expires within the threshold. */
export function isExpiringSoon(alias: Alias, now: number, thresholdMs: number): boolean {
  if (alias.state !== "active" || alias.expiresAt === null) {
    return false;
  }
  const expiresAt = Date.parse(alias.expiresAt);
  return expiresAt > now && expiresAt <= now + thresholdMs;
}

/** The dashboard counts derived from the full alias and quarantine sets. */
export interface DashboardCounts {
  active: number;
  expiringSoon: number;
  expired: number;
  disabled: number;
  quarantined: number;
}

/** Map alias IDs to their addresses for display. */
export function aliasAddressMap(aliases: readonly Alias[]): Map<string, string> {
  return new Map(aliases.map((alias) => [alias.id, alias.address]));
}

/** Count quarantined messages per alias ID. */ export function countQuarantineByAlias(
  messages: readonly QuarantinedMessage[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of messages) {
    if (message.status !== "quarantined") {
      continue;
    }
    for (const aliasId of message.aliasIds) {
      counts[aliasId] = (counts[aliasId] ?? 0) + 1;
    }
  }
  return counts;
}

/** Derive the dashboard counts. Effective state comes from the server. */
export function deriveDashboardCounts(
  aliases: readonly Alias[],
  quarantineCounts: Readonly<Record<string, number>>,
  now: number,
  expiringSoonMs: number,
): DashboardCounts {
  let active = 0;
  let expiringSoon = 0;
  let expired = 0;
  let disabled = 0;
  for (const alias of aliases) {
    switch (alias.state) {
      case "active":
        active += 1;
        if (isExpiringSoon(alias, now, expiringSoonMs)) {
          expiringSoon += 1;
        }
        break;
      case "expired":
        expired += 1;
        break;
      case "disabled":
        disabled += 1;
        break;
    }
  }
  const quarantined = Object.values(quarantineCounts).reduce((total, value) => total + value, 0);
  return { active, expiringSoon, expired, disabled, quarantined };
}
