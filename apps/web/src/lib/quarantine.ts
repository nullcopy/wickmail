import type { QuarantinedMessage } from "wickmail-core";

/** The quarantine screen filters. */
export interface QuarantineCriteria {
  /** The alias to filter by, or `all`. */
  aliasId: string | "all";
  /** Free-text search over sender and subject. */
  search: string;
  /** The received-date window start, as a `YYYY-MM-DD` date. */
  from: string;
  /** The received-date window end, as a `YYYY-MM-DD` date. */
  to: string;
}

/** The default quarantine criteria: every message, newest first. */
export const DEFAULT_QUARANTINE_CRITERIA: QuarantineCriteria = {
  aliasId: "all",
  search: "",
  from: "",
  to: "",
};

function startOfDayMs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

function endOfDayMs(date: string): number {
  return Date.parse(`${date}T23:59:59.999Z`);
}

/**
 * Filter quarantined messages by alias, sender/subject search, and received
 * date. The date window is inclusive; an empty bound is unbounded.
 */
export function filterQuarantine(
  messages: readonly QuarantinedMessage[],
  criteria: QuarantineCriteria,
): QuarantinedMessage[] {
  const search = criteria.search.trim().toLowerCase();
  const from = criteria.from.length > 0 ? startOfDayMs(criteria.from) : null;
  const to = criteria.to.length > 0 ? endOfDayMs(criteria.to) : null;

  return messages.filter((message) => {
    if (criteria.aliasId !== "all" && !message.aliasIds.includes(criteria.aliasId)) {
      return false;
    }
    if (search.length > 0) {
      const haystack = `${message.sender ?? ""} ${message.subject ?? ""}`.toLowerCase();
      if (!haystack.includes(search)) {
        return false;
      }
    }
    const received = Date.parse(message.receivedAt);
    if (from !== null && received < from) {
      return false;
    }
    if (to !== null && received > to) {
      return false;
    }
    return true;
  });
}

/** Sort messages newest received first, with a stable message-ID tiebreak. */
export function sortQuarantineByReceived(
  messages: readonly QuarantinedMessage[],
): QuarantinedMessage[] {
  return [...messages].sort((left, right) => {
    const delta = Date.parse(right.receivedAt) - Date.parse(left.receivedAt);
    if (delta !== 0) {
      return delta;
    }
    return left.messageId.localeCompare(right.messageId);
  });
}

/** The retention deadline for a quarantined message, or `null` when none. */
export function retentionDeadline(message: QuarantinedMessage): string | null {
  return message.quarantineExpiresAt;
}

/** Whether a message is still quarantined and can be acted on. */
export function isActionable(message: QuarantinedMessage): boolean {
  return message.status === "quarantined";
}
