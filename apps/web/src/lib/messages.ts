/**
 * Message list presentation logic.
 *
 * The messages view is delivery metadata only; it never renders bodies.
 */

import type { Message } from "@wickmail/core";

/** Active message filters. */
export interface MessageFilters {
  aliasId: string;
  search: string;
  from: string;
  to: string;
}

/** The default filter set: everything, newest first. */
export function defaultMessageFilters(): MessageFilters {
  return { aliasId: "", search: "", from: "", to: "" };
}

function time(value: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Applies alias, sender/subject, and date filters. */
export function filterMessages(items: readonly Message[], filters: MessageFilters): Message[] {
  const from = time(filters.from);
  const to = time(filters.to);
  const search = filters.search.trim().toLowerCase();
  return items.filter((message) => {
    if (filters.aliasId && !message.aliasIds.includes(filters.aliasId)) return false;
    const received = time(message.receivedAt);
    if (from !== null && (received === null || received < from)) return false;
    if (to !== null && (received === null || received > to)) return false;
    if (search) {
      const haystack = `${message.sender} ${message.subject}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}
