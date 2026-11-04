import { z } from "zod";
import { aliasSchema } from "./alias.js";
import { aliasStateSchema } from "./lease.js";
import { idSchema, timestampSchema } from "./primitives.js";
import { createValidator, type Validator } from "./validation.js";

/** A requested lease at alias creation. */
export const aliasLeaseRequestSchema = z.discriminatedUnion("type", [
  /** A relative lease, stored as `created_at + durationSeconds`. */
  z.object({ type: z.literal("duration"), durationSeconds: z.number().int().positive() }),
  /** An absolute expiry. */
  z.object({ type: z.literal("absolute"), expiresAt: timestampSchema }),
  /** No expiry. */
  z.object({ type: z.literal("none") }),
]);

/** A requested lease at alias creation. */
export type AliasLeaseRequest = z.infer<typeof aliasLeaseRequestSchema>;

/**
 * `POST /v1/aliases`. The server generates the local part, so the request
 * never carries an address or local part; strict parsing rejects them.
 */
export const createAliasRequestSchema = z
  .object({
    label: z.string().min(1).max(200),
    purpose: z.string().max(2000).nullable().optional(),
    lease: aliasLeaseRequestSchema.optional(),
    renewOnOutbound: z.boolean().optional(),
  })
  .strict();

/** `POST /v1/aliases` request body. */
export type CreateAliasRequest = z.infer<typeof createAliasRequestSchema>;

/** `POST /v1/aliases` and single-alias responses. */
export const aliasResponseSchema = z.object({ alias: aliasSchema });

/** A single-alias response body. */
export type AliasResponse = z.infer<typeof aliasResponseSchema>;

/** Sort keys for `GET /v1/aliases`. */
export const aliasSortSchema = z.enum(["expires", "lastUsed", "created"]);

/** Sort keys for `GET /v1/aliases`. */
export type AliasSort = z.infer<typeof aliasSortSchema>;

/** Sort directions for `GET /v1/aliases`. */
export const sortOrderSchema = z.enum(["asc", "desc"]);

/** Sort directions for `GET /v1/aliases`. */
export type SortOrder = z.infer<typeof sortOrderSchema>;

/** `GET /v1/aliases` query parameters, after query-string coercion. */
export const listAliasesQuerySchema = z
  .object({
    state: aliasStateSchema.optional(),
    hasExpiry: z.boolean().optional(),
    expiresBefore: timestampSchema.optional(),
    expiresAfter: timestampSchema.optional(),
    search: z.string().optional(),
    sort: aliasSortSchema.optional(),
    order: sortOrderSchema.optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  })
  .strict();

/** `GET /v1/aliases` query parameters. */
export type ListAliasesQuery = z.infer<typeof listAliasesQuerySchema>;

/** `GET /v1/aliases` response body. */
export const listAliasesResponseSchema = z.object({
  aliases: z.array(aliasSchema),
  nextCursor: z.string().nullable(),
});

/** `GET /v1/aliases` response body. */
export type ListAliasesResponse = z.infer<typeof listAliasesResponseSchema>;

/**
 * `PATCH /v1/aliases/{id}`. `policyVersion` carries optimistic concurrency;
 * the server rejects the write when it does not match the stored version.
 */
export const updateAliasRequestSchema = z
  .object({
    label: z.string().min(1).max(200).optional(),
    purpose: z.string().max(2000).nullable().optional(),
    renewOnOutbound: z.boolean().optional(),
    policyVersion: z.number().int().nonnegative(),
  })
  .strict();

/** `PATCH /v1/aliases/{id}` request body. */
export type UpdateAliasRequest = z.infer<typeof updateAliasRequestSchema>;

/** `POST /v1/aliases/{id}/renew` request body. */
export const renewAliasRequestSchema = z
  .object({ durationSeconds: z.number().int().positive().optional() })
  .strict();

/** `POST /v1/aliases/{id}/renew` request body. */
export type RenewAliasRequest = z.infer<typeof renewAliasRequestSchema>;

/** `POST /v1/aliases/{id}/extend` request body. */
export const extendAliasRequestSchema = z
  .object({ durationSeconds: z.number().int().positive().optional() })
  .strict();

/** `POST /v1/aliases/{id}/extend` request body. */
export type ExtendAliasRequest = z.infer<typeof extendAliasRequestSchema>;

/** `POST /v1/aliases/{id}/enable` request body. */
export const enableAliasRequestSchema = z
  .object({ expiresAt: timestampSchema.optional() })
  .strict();

/** `POST /v1/aliases/{id}/enable` request body. */
export type EnableAliasRequest = z.infer<typeof enableAliasRequestSchema>;

/**
 * Lifecycle event types. "Expired" is a presentation state derived from
 * `expiresAt` at read time; `expired_derived` is recorded only when a
 * deduplicated expiration event is emitted, and never changes evaluation.
 */
export const aliasEventTypeSchema = z.enum([
  "created",
  "renewed_by_outbound",
  "renewed_manually",
  "extended_manually",
  "expiry_set",
  "expiry_removed",
  "expired_derived",
  "recovered",
  "replied_as_alias",
  "disabled",
  "enabled",
]);

/** A lifecycle event type. */
export type AliasEventType = z.infer<typeof aliasEventTypeSchema>;

/** A lifecycle event. `detail` never contains a message body. */
export const aliasEventSchema = z.object({
  id: idSchema,
  aliasId: idSchema,
  type: aliasEventTypeSchema,
  occurredAt: timestampSchema,
  detail: z.record(z.string(), z.unknown()).nullable(),
});

/** A lifecycle event. */
export type AliasEvent = z.infer<typeof aliasEventSchema>;

/** `GET /v1/aliases/{id}/events` response body. */
export const listAliasEventsResponseSchema = z.object({ events: z.array(aliasEventSchema) });

/** `GET /v1/aliases/{id}/events` response body. */
export type ListAliasEventsResponse = z.infer<typeof listAliasEventsResponseSchema>;

/** Validation helpers for the management API request and response schemas. */
export const createAliasRequestValidator: Validator<CreateAliasRequest> =
  createValidator(createAliasRequestSchema);
export const aliasResponseValidator: Validator<AliasResponse> =
  createValidator(aliasResponseSchema);
export const listAliasesQueryValidator: Validator<ListAliasesQuery> =
  createValidator(listAliasesQuerySchema);
export const listAliasesResponseValidator: Validator<ListAliasesResponse> =
  createValidator(listAliasesResponseSchema);
export const updateAliasRequestValidator: Validator<UpdateAliasRequest> =
  createValidator(updateAliasRequestSchema);
export const renewAliasRequestValidator: Validator<RenewAliasRequest> =
  createValidator(renewAliasRequestSchema);
export const extendAliasRequestValidator: Validator<ExtendAliasRequest> =
  createValidator(extendAliasRequestSchema);
export const enableAliasRequestValidator: Validator<EnableAliasRequest> =
  createValidator(enableAliasRequestSchema);
export const aliasEventValidator: Validator<AliasEvent> = createValidator(aliasEventSchema);
export const listAliasEventsResponseValidator: Validator<ListAliasEventsResponse> = createValidator(
  listAliasEventsResponseSchema,
);
