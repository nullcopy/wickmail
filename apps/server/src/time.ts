/**
 * Wickmail stores every timestamp as milliseconds since the Unix epoch in UTC.
 * Epoch milliseconds are unambiguous, so stored values need no timezone
 * interpretation at evaluation time.
 */

/** Milliseconds since the Unix epoch, UTC. */
export type EpochMs = number;

/** The current time as epoch milliseconds. */
export function nowMs(): EpochMs {
  return Date.now();
}

/** Convert stored epoch milliseconds to an ISO 8601 UTC timestamp. */
export function toIsoTimestamp(value: EpochMs | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** Convert an ISO 8601 timestamp to epoch milliseconds. */
export function fromIsoTimestamp(value: string): EpochMs {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new TypeError(`invalid ISO 8601 timestamp: ${value}`);
  }
  return parsed;
}

/** Convert a duration in seconds to milliseconds. */
export function secondsToMs(seconds: number): number {
  return seconds * 1000;
}
