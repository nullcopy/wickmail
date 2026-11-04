import { z } from "zod";
import { sortOrderSchema } from "./api.js";
import { quarantineStatusSchema, quarantinedMessageSchema } from "./message.js";
import { idSchema, timestampSchema } from "./primitives.js";
import { createValidator, type Validator } from "./validation.js";

/** Sort keys for `GET /v1/quarantine`. */
export const quarantineSortSchema = z.enum(["received", "expires"]);

/** Sort keys for `GET /v1/quarantine`. */
export type QuarantineSort = z.infer<typeof quarantineSortSchema>;

/** `GET /v1/quarantine` query parameters, after query-string coercion. */
export const listQuarantineQuerySchema = z
  .object({
    status: quarantineStatusSchema.optional(),
    aliasId: idSchema.optional(),
    search: z.string().optional(),
    sort: quarantineSortSchema.optional(),
    order: sortOrderSchema.optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  })
  .strict();

/** `GET /v1/quarantine` query parameters. */
export type ListQuarantineQuery = z.infer<typeof listQuarantineQuerySchema>;

/** `GET /v1/quarantine` response body. */
export const listQuarantineResponseSchema = z.object({
  messages: z.array(quarantinedMessageSchema),
  nextCursor: z.string().nullable(),
});

/** `GET /v1/quarantine` response body. */
export type ListQuarantineResponse = z.infer<typeof listQuarantineResponseSchema>;

/** `GET /v1/quarantine/{id}` response body. */
export const quarantineResponseSchema = z.object({ message: quarantinedMessageSchema });

/** `GET /v1/quarantine/{id}` response body. */
export type QuarantineResponse = z.infer<typeof quarantineResponseSchema>;

/**
 * `POST /v1/quarantine/{id}/recover` request body. `renew` applies a renewal
 * after recovery; `enable` enables a disabled alias. They are mutually
 * exclusive.
 */
export const recoverQuarantineRequestSchema = z
  .object({
    renew: z.boolean().optional(),
    enable: z.boolean().optional(),
    durationSeconds: z.number().int().positive().optional(),
    expiresAt: timestampSchema.optional(),
  })
  .strict();

/** `POST /v1/quarantine/{id}/recover` request body. */
export type RecoverQuarantineRequest = z.infer<typeof recoverQuarantineRequestSchema>;

/** `POST /v1/quarantine/{id}/recover` response body. */
export const recoverQuarantineResponseSchema = z.object({
  status: z.enum(["recovered", "already_recovered"]),
  message: quarantinedMessageSchema,
});

/** `POST /v1/quarantine/{id}/recover` response body. */
export type RecoverQuarantineResponse = z.infer<typeof recoverQuarantineResponseSchema>;

/** `POST /v1/quarantine/{id}/delete` request body. */
export const deleteQuarantineRequestSchema = z
  .object({ reason: z.string().min(1).max(500).optional() })
  .strict();

/** `POST /v1/quarantine/{id}/delete` request body. */
export type DeleteQuarantineRequest = z.infer<typeof deleteQuarantineRequestSchema>;

/** `POST /v1/quarantine/{id}/delete` response body. */
export const deleteQuarantineResponseSchema = z.object({
  status: z.enum(["deleted", "already_deleted"]),
  messageId: z.string().min(1),
});

/** `POST /v1/quarantine/{id}/delete` response body. */
export type DeleteQuarantineResponse = z.infer<typeof deleteQuarantineResponseSchema>;

/** Validation helpers for the quarantine request and response schemas. */
export const listQuarantineQueryValidator: Validator<ListQuarantineQuery> =
  createValidator(listQuarantineQuerySchema);
export const listQuarantineResponseValidator: Validator<ListQuarantineResponse> = createValidator(
  listQuarantineResponseSchema,
);
export const quarantineResponseValidator: Validator<QuarantineResponse> =
  createValidator(quarantineResponseSchema);
export const recoverQuarantineRequestValidator: Validator<RecoverQuarantineRequest> =
  createValidator(recoverQuarantineRequestSchema);
export const recoverQuarantineResponseValidator: Validator<RecoverQuarantineResponse> =
  createValidator(recoverQuarantineResponseSchema);
export const deleteQuarantineRequestValidator: Validator<DeleteQuarantineRequest> = createValidator(
  deleteQuarantineRequestSchema,
);
export const deleteQuarantineResponseValidator: Validator<DeleteQuarantineResponse> =
  createValidator(deleteQuarantineResponseSchema);
