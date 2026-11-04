import type { AliasState } from "wickmail-core";
import { canonicalizeAddress, splitCanonicalAddress } from "../alias/canonical.js";
import { findAliasByAddress, type AliasRow } from "../alias/repository.js";
import type { SqliteDatabase } from "../db/database.js";
import { effectiveState } from "../lease/state.js";

/** A recipient policy decision for the RCPT stage. */
export type RecipientDecision =
  | { outcome: "accept"; recipient: "alias"; aliasId: string; state: AliasState }
  | { outcome: "accept"; recipient: "primary" }
  | { outcome: "reject"; reason: "unknown" | "disabled" }
  | { outcome: "tempfail"; reason: string };

/** Looks up an alias by its canonical address. */
export type AliasLookup = (canonicalAddress: string) => AliasRow | undefined;

/** Inputs for a recipient policy evaluation. */
export interface RecipientPolicyInput {
  /** The recipient address exactly as the MTA supplied it. */
  address: string;
  /** The current time in epoch milliseconds. */
  now: number;
  /** Case-insensitive alias lookup by canonical address. */
  lookupAlias: AliasLookup;
  /** Canonical primary addresses that are always accepted. */
  primaryAddresses: ReadonlySet<string>;
  /** Domains this server is authoritative for. */
  localDomains: ReadonlySet<string>;
}

function canonicalizeOrNull(address: string): string | null {
  try {
    return canonicalizeAddress(address);
  } catch {
    return null;
  }
}

/**
 * Evaluate a recipient at the RCPT stage.
 *
 * Unknown and disabled recipients are permanent failures; active and expired
 * recipients are accepted. A lookup that throws is reported as a temporary
 * failure, never as an unknown recipient, so an internal error can never cause
 * mail to be permanently rejected.
 */
export function evaluateRecipient(input: RecipientPolicyInput): RecipientDecision {
  const canonical = canonicalizeOrNull(input.address);
  if (canonical === null) {
    return { outcome: "reject", reason: "unknown" };
  }
  if (!input.localDomains.has(splitCanonicalAddress(canonical).domain)) {
    return { outcome: "reject", reason: "unknown" };
  }
  if (input.primaryAddresses.has(canonical)) {
    return { outcome: "accept", recipient: "primary" };
  }

  let alias: AliasRow | undefined;
  try {
    alias = input.lookupAlias(canonical);
  } catch (error) {
    return { outcome: "tempfail", reason: errorMessage(error) };
  }

  if (alias === undefined) {
    return { outcome: "reject", reason: "unknown" };
  }

  const state = effectiveState(alias, input.now);
  if (state === "disabled") {
    return { outcome: "reject", reason: "disabled" };
  }
  return { outcome: "accept", recipient: "alias", aliasId: alias.id, state };
}

/** A recipient policy bound to a database and configuration. */
export interface RecipientPolicy {
  evaluate(address: string, now: number): RecipientDecision;
}

/** Options for {@link createRecipientPolicy}. */
export interface RecipientPolicyOptions {
  db: SqliteDatabase;
  /** Primary addresses, canonicalized on construction. */
  primaryAddresses?: readonly string[];
  /** Local domains, canonicalized on construction. */
  localDomains: readonly string[];
  /** Overrides alias lookup, used by tests to inject outages. */
  lookupAlias?: AliasLookup;
}

/** Build a recipient policy backed by the alias database. */
export function createRecipientPolicy(options: RecipientPolicyOptions): RecipientPolicy {
  const primaryAddresses = new Set(
    (options.primaryAddresses ?? []).map((address) => canonicalizeAddress(address)),
  );
  const localDomains = new Set(options.localDomains.map((domain) => domain.trim().toLowerCase()));
  const lookupAlias =
    options.lookupAlias ?? ((canonical: string) => findAliasByAddress(options.db, canonical));

  return {
    evaluate: (address, now) =>
      evaluateRecipient({ address, now, lookupAlias, primaryAddresses, localDomains }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
