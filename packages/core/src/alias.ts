import { z } from "zod";
import { aliasStateSchema, leasePolicySchema } from "./lease.js";
import { emailAddressSchema, idSchema, timestampSchema } from "./primitives.js";

/**
 * A Wickmail alias as returned by the management API.
 *
 * `state` is the effective state computed by the server. The raw timestamps
 * are returned alongside it so clients can present them without duplicating
 * lease evaluation.
 */
export const aliasSchema = z.object({
  id: idSchema,
  address: emailAddressSchema,
  label: z.string().min(1).max(200),
  purpose: z.string().max(2000).nullable(),
  state: aliasStateSchema,
  lease: leasePolicySchema,
  createdAt: timestampSchema,
  expiresAt: timestampSchema.nullable(),
  disabledAt: timestampSchema.nullable(),
  lastInboundAt: timestampSchema.nullable(),
  lastUserActivityAt: timestampSchema.nullable(),
  policyVersion: z.number().int().nonnegative(),
});

/** A Wickmail alias. */
export type Alias = z.infer<typeof aliasSchema>;

/**
 * The persisted fields that determine effective state and lease behavior.
 * This mirrors the stored representation, not the wire representation.
 */
export const aliasLeaseFieldsSchema = z.object({
  expiresAt: timestampSchema.nullable(),
  disabledAt: timestampSchema.nullable(),
  leaseDurationSeconds: z.number().int().positive(),
  renewOnOutbound: z.boolean(),
  lastInboundAt: timestampSchema.nullable(),
  lastUserActivityAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});

/** Persisted lease-relevant alias fields. */
export type AliasLeaseFields = z.infer<typeof aliasLeaseFieldsSchema>;
