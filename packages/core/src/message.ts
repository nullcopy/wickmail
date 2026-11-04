import { z } from "zod";
import { emailAddressSchema, idSchema, timestampSchema } from "./primitives.js";

/**
 * The trusted set of recipients that received a message, recorded from the
 * SMTP envelope. Envelope recipients are authoritative; visible `To` and `Cc`
 * are cross-checked for display only.
 */
export const provenanceSchema = z.object({
  /** The stable `X-Wickmail-Message-ID`. */
  messageId: z.string().min(1),
  /** Alias IDs that received the message, in stable order. */
  aliasIds: z.array(idSchema),
  /** Whether the primary address received the message. */
  primaryReceived: z.boolean(),
  /** The envelope recipients, including blind copies. */
  envelopeRecipients: z.array(emailAddressSchema),
});

/** Trusted message provenance. */
export type Provenance = z.infer<typeof provenanceSchema>;

/**
 * Quarantine membership status. The mail store is authoritative for the
 * message itself; the management database caches this status.
 */
export const quarantineStatusSchema = z.enum([
  "quarantined",
  "recovering",
  "recovered",
  "deleting",
  "deleted",
]);

/** Quarantine membership status. */
export type QuarantineStatus = z.infer<typeof quarantineStatusSchema>;

/** A cached locator for a message in the mail store. */
export const messageLocatorSchema = z.object({
  mailbox: z.string().min(1),
  uidValidity: z.number().int().nonnegative(),
  uid: z.number().int().nonnegative(),
});

/** A cached mail-store locator. */
export type MessageLocator = z.infer<typeof messageLocatorSchema>;

/** Quarantine metadata for a message addressed to one or more aliases. */
export const quarantinedMessageSchema = z.object({
  messageId: z.string().min(1),
  aliasIds: z.array(idSchema),
  sender: z.string().nullable(),
  subject: z.string().nullable(),
  receivedAt: timestampSchema,
  quarantineExpiresAt: timestampSchema.nullable(),
  status: quarantineStatusSchema,
  locator: messageLocatorSchema.nullable(),
});

/** Quarantine metadata for a message. */
export type QuarantinedMessage = z.infer<typeof quarantinedMessageSchema>;
