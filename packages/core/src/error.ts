import { z } from "zod";
import { createValidator, type Validator } from "./validation.js";

/**
 * The management API error body. Every non-2xx response carries a stable
 * machine-readable `code`, a human-readable `message`, and optional `details`.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

/** A management API error body. */
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Validation helper for error bodies. */
export const apiErrorValidator: Validator<ApiError> = createValidator(apiErrorSchema);
