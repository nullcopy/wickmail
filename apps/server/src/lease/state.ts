import type { AliasState } from "wickmail-core";

/** The stored fields that determine effective state. */
export interface LeaseStateFields {
  /** Absolute expiry in epoch milliseconds, or null for no expiry. */
  expiresAt: number | null;
  /** Disabled timestamp in epoch milliseconds, or null when enabled. */
  disabledAt: number | null;
}

/**
 * Compute the effective state from stored fields at evaluation time.
 *
 * Precedence is disabled over expired over active, so a disabled alias is
 * never reported as expired, and a disabled or expired alias is never active.
 * No scheduler or hidden state participates.
 */
export function effectiveState(fields: LeaseStateFields, now: number): AliasState {
  if (fields.disabledAt !== null) {
    return "disabled";
  }
  if (fields.expiresAt !== null && fields.expiresAt <= now) {
    return "expired";
  }
  return "active";
}
