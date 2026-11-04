import { z } from "zod";
import { provenanceSchema } from "./message.js";
import { idSchema, timestampSchema } from "./primitives.js";
import { createValidator, type Validator } from "./validation.js";

/**
 * The identity used to send a reply. A reply is always sent as one identity:
 * an owned alias, or the primary address when no alias received the message.
 */
export const replyIdentitySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("alias"),
    aliasId: idSchema,
    address: z.string().min(1),
  }),
  z.object({
    kind: z.literal("primary"),
    address: z.string().min(1),
  }),
]);

/** A reply sending identity. */
export type ReplyIdentity = z.infer<typeof replyIdentitySchema>;

/**
 * How the reply identity was chosen. `default` means the server selected an
 * identity; `prompt` means the client must ask the user to choose and must not
 * send silently.
 */
export const replyIdentitySelectionSchema = z.enum(["default", "prompt"]);

/** How the reply identity was chosen. */
export type ReplyIdentitySelection = z.infer<typeof replyIdentitySelectionSchema>;

/**
 * The reply-identity decision for a message's trusted provenance. `selected`
 * is the default identity, or null when the client must prompt. `options` are
 * the identities the client may offer, in preference order.
 */
export const replyIdentityDecisionSchema = z.object({
  selection: replyIdentitySelectionSchema,
  selected: replyIdentitySchema.nullable(),
  options: z.array(replyIdentitySchema),
});

/** A reply-identity decision. */
export type ReplyIdentityDecision = z.infer<typeof replyIdentityDecisionSchema>;

/**
 * Sanitized reply context for one message. It carries only what the composer
 * needs: the original sender, subject, sanitized plain-text body, threading
 * message ID, trusted provenance, and the identity decision. It is not a
 * general message browser.
 */
export const replyContextSchema = z.object({
  /** The trusted `X-Wickmail-Message-ID`. */
  messageId: z.string().min(1),
  /** The original sender address, or null when it cannot be determined. */
  sender: z.string().nullable(),
  /** The original subject, or null when absent. */
  subject: z.string().nullable(),
  /** The sanitized plain-text body. */
  text: z.string(),
  /** The original RFC 5322 `Message-ID`, for threading, or null. */
  originalMessageId: z.string().nullable(),
  /** The trusted envelope provenance recorded at acceptance. */
  provenance: provenanceSchema,
  /** The reply-identity decision derived from provenance and ownership. */
  identity: replyIdentityDecisionSchema,
});

/** Sanitized reply context. */
export type ReplyContext = z.infer<typeof replyContextSchema>;

/**
 * `POST /v1/messages/{id}/reply`. `aliasId` selects an owned alias; null or
 * omitted selects the primary identity. `body` is the plain-text reply and
 * `quotedText` is optional quoted history.
 */
export const replyRequestSchema = z
  .object({
    aliasId: idSchema.nullable().optional(),
    body: z.string(),
    quotedText: z.string().optional(),
  })
  .strict();

/** `POST /v1/messages/{id}/reply` request body. */
export type ReplyRequest = z.infer<typeof replyRequestSchema>;

/** The queued result of a reply submission. */
export const replyResultSchema = z.object({
  messageId: z.string().min(1),
  identity: replyIdentitySchema,
  /** Whether the alias lease was renewed by the submission. */
  renewed: z.boolean(),
  /** The resulting absolute expiry in UTC, or null for no expiry. */
  expiresAt: timestampSchema.nullable(),
});

/** A queued reply result. */
export type ReplyResult = z.infer<typeof replyResultSchema>;

/** Validation helpers for the reply request and response schemas. */
export const replyIdentityDecisionValidator: Validator<ReplyIdentityDecision> = createValidator(
  replyIdentityDecisionSchema,
);
export const replyContextValidator: Validator<ReplyContext> = createValidator(replyContextSchema);
export const replyRequestValidator: Validator<ReplyRequest> = createValidator(replyRequestSchema);
export const replyResultValidator: Validator<ReplyResult> = createValidator(replyResultSchema);
