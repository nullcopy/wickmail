/**
 * Version of the management API contract this client mirrors.
 *
 * The Rust server is the source of truth for the contract; this value changes
 * when the client is updated to match a new server contract version.
 */
export const API_CONTRACT_VERSION = "0.0.0";

/** Lifecycle state of an alias, computed by the server. */
export type AliasState = "active" | "expired" | "disabled";

/**
 * An alias as returned by the management API.
 *
 * Clients consume the server-computed {@link Alias.state} and raw timestamps;
 * they never derive lease state themselves.
 */
export interface Alias {
  /** Opaque, server-assigned identifier. */
  id: string;
  /** Full address, for example `green.farm@example.com`. */
  address: string;
  /** Server-computed lifecycle state. */
  state: AliasState;
  /** Lease expiry as an RFC 3339 timestamp in UTC. */
  expiresAt: string;
}

/** Returns true when the alias currently delivers mail to the inbox. */
export function isActive(alias: Alias): boolean {
  return alias.state === "active";
}
