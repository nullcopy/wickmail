import { z } from "zod";

/**
 * Trusted inbound headers added by the Wickmail LMTP proxy after it strips
 * client-supplied headers. They are inbound-only: the proxy strips every
 * `X-Wickmail-*` header from client input and from outbound mail, so a value
 * present after the strip step was set by the proxy.
 */
export const wickmailHeader = {
  /** Stable message identity, a UUIDv7 assigned at acceptance. */
  messageId: "X-Wickmail-Message-ID",
  /** One entry per receiving alias. */
  aliasId: "X-Wickmail-Alias-ID",
  /** The trusted delivery route. */
  route: "X-Wickmail-Route",
  /** Acceptance time in UTC, as an RFC 3339 timestamp. */
  receivedAt: "X-Wickmail-Received-At",
} as const;

/** A trusted inbound header name. */
export type WickmailHeaderName = (typeof wickmailHeader)[keyof typeof wickmailHeader];

/** The header namespace reserved for trusted inbound metadata. */
export const WICKMAIL_HEADER_PREFIX = "X-Wickmail-";

/**
 * The trusted delivery route. Spam wins over alias state, so actual spam is
 * routed to `Spam` regardless of whether the receiving alias is active.
 * `Aliases/Expired` is outside the user IMAP namespace.
 */
export const mailRouteSchema = z.enum(["Inbox", "Spam", "Aliases/Expired"]);

/** A trusted delivery route. */
export type MailRoute = z.infer<typeof mailRouteSchema>;

/**
 * The trusted message envelope recorded at acceptance. Envelope recipients are
 * authoritative and include blind copies; visible `To` and `Cc` are
 * cross-checked for display only.
 */
export const inboundEnvelopeSchema = z.object({
  /** The SMTP `MAIL FROM` path, or the null sender for bounces. */
  mailFrom: z.string(),
  /** The SMTP `RCPT TO` paths, in receipt order. */
  recipients: z.array(z.string()),
});

/** A trusted message envelope. */
export type InboundEnvelope = z.infer<typeof inboundEnvelopeSchema>;
