/**
 * Quarantine list presentation logic.
 *
 * Only metadata is handled here. Message bodies are never rendered; the reply
 * composer fetches sanitized reply context on demand.
 */

import type { QuarantineResponse } from "@wickmail/core";

/** Active quarantine filters. */
export interface QuarantineFilters {
  aliasId: string;
  search: string;
  from: string;
  to: string;
}

/** The default filter set: everything, newest first. */
export function defaultQuarantineFilters(): QuarantineFilters {
  return { aliasId: "", search: "", from: "", to: "" };
}

function time(value: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Returns true for messages still held in quarantine. */
export function isHeld(item: QuarantineResponse): boolean {
  return item.status === "quarantined" || item.status === "recovering";
}

/** Applies alias, date-range, and sender/subject filters. */
export function filterQuarantine(
  items: readonly QuarantineResponse[],
  filters: QuarantineFilters,
): QuarantineResponse[] {
  const from = time(filters.from);
  const to = time(filters.to);
  const search = filters.search.trim().toLowerCase();
  return items.filter((item) => {
    if (filters.aliasId && !item.aliasIds.includes(filters.aliasId)) return false;
    const received = time(item.receivedAt);
    if (from !== null && (received === null || received < from)) return false;
    if (to !== null && (received === null || received > to)) return false;
    if (search) {
      const haystack = `${item.sender} ${item.subject}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}
