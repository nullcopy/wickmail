import type { z } from "zod";

/** The result of validating an unknown payload against a schema. */
export type ValidationResult<T> = ReturnType<z.ZodType<T>["safeParse"]>;

/**
 * A pair of validation helpers for one schema. The server validates inbound
 * payloads with these; the web app reuses the same schemas through the API
 * client, so the contract is defined once.
 */
export interface Validator<T> {
  /** Parse `input`, throwing a `ZodError` when it is invalid. */
  parse(input: unknown): T;
  /** Parse `input`, returning a result object instead of throwing. */
  safeParse(input: unknown): ValidationResult<T>;
}

/** Build a `Validator` for a schema. */
export function createValidator<T>(schema: z.ZodType<T>): Validator<T> {
  return {
    parse: (input) => schema.parse(input),
    safeParse: (input) => schema.safeParse(input),
  };
}
