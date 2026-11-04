import type { AliasSort, ListAliasesQuery, SortOrder } from "wickmail-core";
import { effectiveState } from "../lease/state.js";
import type { AliasRow } from "./repository.js";

/** The default number of aliases returned in one page. */
export const DEFAULT_ALIAS_PAGE_SIZE = 50;

/** A page of aliases and the cursor for the next page. */
export interface AliasPage {
  rows: AliasRow[];
  nextCursor: string | null;
}

/** The sort key value for an alias, or null when it has none. */
export function aliasSortValue(row: AliasRow, sort: AliasSort): number | null {
  switch (sort) {
    case "expires":
      return row.expiresAt;
    case "created":
      return row.createdAt;
    case "lastUsed": {
      const values = [row.lastInboundAt, row.lastUserActivityAt].filter(
        (value): value is number => value !== null,
      );
      return values.length === 0 ? row.createdAt : Math.max(...values);
    }
  }
}

function compareValues(left: number | null, right: number | null, order: SortOrder): number {
  // Aliases with no value sort last in both directions, so paging stays stable.
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return order === "asc" ? left - right : right - left;
}

/** Compare two aliases under a sort key and direction, with a stable ID tiebreak. */
export function compareAliases(
  left: AliasRow,
  right: AliasRow,
  sort: AliasSort,
  order: SortOrder,
): number {
  const primary = compareValues(aliasSortValue(left, sort), aliasSortValue(right, sort), order);
  if (primary !== 0) {
    return primary;
  }
  return left.id.localeCompare(right.id);
}

interface AliasCursor {
  v: number | null;
  id: string;
}

/** Encode a pagination cursor. */
export function encodeAliasCursor(row: AliasRow, sort: AliasSort): string {
  const cursor: AliasCursor = { v: aliasSortValue(row, sort), id: row.id };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Decode a pagination cursor, or return undefined when it is malformed. */
export function decodeAliasCursor(raw: string): AliasCursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "id" in parsed &&
      typeof (parsed as { id: unknown }).id === "string"
    ) {
      const value = (parsed as { v?: unknown }).v;
      if (value === null || typeof value === "number") {
        return { v: value, id: (parsed as { id: string }).id };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function matchesSearch(row: AliasRow, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return (
    row.address.toLowerCase().includes(needle) ||
    row.label.toLowerCase().includes(needle) ||
    (row.purpose ?? "").toLowerCase().includes(needle)
  );
}

function matchesQuery(row: AliasRow, query: ListAliasesQuery, now: number): boolean {
  if (query.state !== undefined && effectiveState(row, now) !== query.state) {
    return false;
  }
  if (query.hasExpiry !== undefined && (row.expiresAt !== null) !== query.hasExpiry) {
    return false;
  }
  if (
    query.expiresBefore !== undefined &&
    (row.expiresAt === null || row.expiresAt > Date.parse(query.expiresBefore))
  ) {
    return false;
  }
  if (
    query.expiresAfter !== undefined &&
    (row.expiresAt === null || row.expiresAt < Date.parse(query.expiresAfter))
  ) {
    return false;
  }
  if (query.search !== undefined && !matchesSearch(row, query.search)) {
    return false;
  }
  return true;
}

/**
 * Filter, sort, and page aliases. Ordering is deterministic: the sort key first,
 * then the alias ID ascending as a stable secondary sort. Aliases with no
 * expiry sort last in both directions.
 */
export function queryAliases(
  rows: readonly AliasRow[],
  query: ListAliasesQuery,
  now: number,
): AliasPage {
  const sort = query.sort ?? "created";
  const order = query.order ?? "desc";
  const limit = query.limit ?? DEFAULT_ALIAS_PAGE_SIZE;

  const filtered = rows.filter((row) => matchesQuery(row, query, now));
  filtered.sort((left, right) => compareAliases(left, right, sort, order));

  let start = 0;
  if (query.cursor !== undefined) {
    const cursor = decodeAliasCursor(query.cursor);
    if (cursor === undefined) {
      return { rows: [], nextCursor: null };
    }
    start = filtered.findIndex((row) => {
      const primary = compareValues(aliasSortValue(row, sort), cursor.v, order);
      if (primary !== 0) {
        return primary > 0;
      }
      return row.id.localeCompare(cursor.id) > 0;
    });
    if (start === -1) {
      return { rows: [], nextCursor: null };
    }
  }

  const page = filtered.slice(start, start + limit);
  const hasMore = filtered.length > start + limit;
  return {
    rows: page,
    nextCursor: hasMore && page.length > 0 ? encodeAliasCursor(page[page.length - 1]!, sort) : null,
  };
}
