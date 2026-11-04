import { z } from "zod";

/**
 * The effective state of an alias.
 *
 * The server computes this from stored fields at evaluation time. Clients
 * consume the server-computed value and never derive it from timestamps.
 */
export const aliasStateSchema = z.enum(["active", "expired", "disabled"]);

/** The effective state of an alias, as computed by the server. */
export type AliasState = z.infer<typeof aliasStateSchema>;

/**
 * Lease policy stored alongside an alias. None of this is encoded in the
 * address, so changing policy never changes the address.
 */
export const leasePolicySchema = z.object({
  /** Renewal duration, in seconds, used when a renewal omits a duration. */
  leaseDurationSeconds: z.number().int().positive(),
  /** Whether authenticated outbound mail renews the lease. */
  renewOnOutbound: z.boolean(),
});

/** Lease policy stored alongside an alias. */
export type LeasePolicy = z.infer<typeof leasePolicySchema>;
