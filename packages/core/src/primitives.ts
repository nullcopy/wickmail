import { z } from "zod";

/**
 * An RFC 3339 timestamp in UTC. Wickmail stores and evaluates every timestamp
 * in UTC, so the trailing `Z` designator is required and numeric offsets are
 * rejected.
 */
export const timestampSchema = z.iso.datetime();

/** A timestamp string in UTC, as carried on the management API. */
export type Timestamp = z.infer<typeof timestampSchema>;

/**
 * A canonical email address. Uniqueness is enforced by the server on this
 * value, so it is always lowercased and IDN domains are stored as punycode.
 */
export const emailAddressSchema = z.email();

/** A canonical email address. */
export type EmailAddress = z.infer<typeof emailAddressSchema>;

/** A stable internal identifier for an alias or message. */
export const idSchema = z.uuid();

/** A stable internal UUID. */
export type Id = z.infer<typeof idSchema>;
