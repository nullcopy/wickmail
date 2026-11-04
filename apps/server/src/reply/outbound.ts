import { randomUUID } from "node:crypto";
import type { ReplyIdentity } from "wickmail-core";
import { canonicalizeAddress, splitCanonicalAddress } from "../alias/canonical.js";
import { parsePathAddress, splitAddressList } from "../mail/envelope.js";
import {
  getHeaderValues,
  isWickmailHeader,
  parseMessage,
  serializeMessage,
  type HeaderField,
} from "../mail/headers.js";

/**
 * Headers that carry inbound routing or authentication state. They are
 * inbound-only and never forwarded on an outbound reply.
 */
export const INBOUND_ONLY_HEADERS: ReadonlySet<string> = new Set([
  "delivered-to",
  "x-envelope-to",
  "x-original-to",
  "envelope-to",
  "x-forwarded-to",
  "apparently-to",
  "return-path",
  "received",
  "authentication-results",
  "arc-seal",
  "arc-message-signature",
  "arc-authentication-results",
  "dkim-signature",
  "bcc",
]);

/**
 * Functional headers whose values are set by the server or carry the reply
 * recipient. They are exempt from the primary-address scan so that a primary
 * reply is not stripped of its own `From`, `To`, or `Cc`.
 */
const IDENTITY_HEADERS: ReadonlySet<string> = new Set([
  "from",
  "sender",
  "reply-to",
  "to",
  "cc",
  "subject",
  "date",
  "message-id",
  "in-reply-to",
  "references",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
]);

/** Options for outbound identity enforcement. */
export interface EnforceOutboundIdentityOptions {
  /** The identity address the reply must be sent as. */
  senderAddress: string;
  /** The SMTP envelope sender, when known; it must equal `senderAddress`. */
  envelopeSender?: string;
  /** Primary addresses whose appearance in a header must be stripped. */
  primaryAddresses?: readonly string[];
}

/** The result of enforcing outbound identity on a composed message. */
export type OutboundIdentityResult =
  | {
      accepted: true;
      /** The message with inbound-only and primary-revealing headers removed. */
      raw: string;
      /** The names of the headers that were removed. */
      removed: string[];
    }
  | { accepted: false; reason: string };

/** Parse every mailbox address in a header value, canonicalized. */
export function parseMailboxAddresses(value: string): string[] {
  const addresses: string[] = [];
  for (const candidate of splitAddressList(value)) {
    try {
      addresses.push(canonicalizeAddress(candidate));
    } catch {
      // An unparseable address cannot match an identity; ignore it.
    }
  }
  return addresses;
}

function tryCanonicalize(address: string): string | null {
  try {
    return canonicalizeAddress(address);
  } catch {
    return null;
  }
}

/**
 * Enforce outbound identity on a composed message.
 *
 * The message must contain exactly one `From` mailbox and, when present, one
 * `Sender` and one `Reply-To` mailbox, all equal to the selected identity. The
 * envelope sender, when supplied, must match too. A failing message is
 * rejected before it is queued. On success, inbound-only headers, the
 * `X-Wickmail-*` namespace, and headers that reveal a primary address are
 * removed.
 */
export function enforceOutboundIdentity(
  raw: string,
  options: EnforceOutboundIdentityOptions,
): OutboundIdentityResult {
  const sender = tryCanonicalize(options.senderAddress);
  if (sender === null) {
    return { accepted: false, reason: "selected identity address is not a valid address" };
  }

  if (options.envelopeSender !== undefined) {
    const envelope = tryCanonicalize(parsePathAddress(options.envelopeSender));
    if (envelope !== sender) {
      return { accepted: false, reason: "envelope sender does not match the selected identity" };
    }
  }

  const from = getHeaderValues(raw, "From").flatMap(parseMailboxAddresses);
  if (from.length !== 1) {
    return { accepted: false, reason: "From must contain exactly one mailbox" };
  }
  if (from[0] !== sender) {
    return { accepted: false, reason: "From does not match the selected identity" };
  }

  const senderHeaders = getHeaderValues(raw, "Sender").flatMap(parseMailboxAddresses);
  if (senderHeaders.length > 0 && (senderHeaders.length !== 1 || senderHeaders[0] !== sender)) {
    return { accepted: false, reason: "Sender must equal the selected identity" };
  }

  const replyTo = getHeaderValues(raw, "Reply-To").flatMap(parseMailboxAddresses);
  if (replyTo.length > 0 && (replyTo.length !== 1 || replyTo[0] !== sender)) {
    return { accepted: false, reason: "Reply-To may only be the selected identity" };
  }

  const primaryAddresses = new Set<string>();
  for (const address of options.primaryAddresses ?? []) {
    const canonical = tryCanonicalize(address);
    if (canonical !== null) {
      primaryAddresses.add(canonical);
    }
  }

  const parsed = parseMessage(raw);
  const kept: HeaderField[] = [];
  const removed: string[] = [];
  for (const header of parsed.headers) {
    if (shouldStripHeader(header, primaryAddresses)) {
      removed.push(header.name);
    } else {
      kept.push(header);
    }
  }

  return { accepted: true, raw: serializeMessage(kept, parsed.body), removed };
}

function shouldStripHeader(header: HeaderField, primaryAddresses: ReadonlySet<string>): boolean {
  const name = header.name.trim().toLowerCase();
  if (isWickmailHeader(header.name) || INBOUND_ONLY_HEADERS.has(name)) {
    return true;
  }
  if (IDENTITY_HEADERS.has(name) || primaryAddresses.size === 0) {
    return false;
  }
  const value = header.value.toLowerCase();
  for (const primary of primaryAddresses) {
    if (value.includes(primary)) {
      return true;
    }
  }
  return false;
}

/** Input for composing a reply message. */
export interface ComposeReplyInput {
  /** The selected sending identity. */
  identity: ReplyIdentity;
  /** The reply recipient, the original sender. */
  to: string;
  /** The original subject; a `Re:` prefix is added when absent. */
  subject: string | null;
  /** The original RFC 5322 `Message-ID`, for threading. */
  originalMessageId?: string | null;
  /** Additional `References` entries, oldest first. */
  references?: readonly string[];
  /** The reply body. */
  body: string;
  /** Optional quoted history, prefixed per line. */
  quotedText?: string;
  /** The composition time in epoch milliseconds. */
  now: number;
  /** An optional display name for the `From` header. */
  fromDisplayName?: string;
  /** Overrides the generated `Message-ID`, for deterministic tests. */
  messageId?: string;
}

function replySubject(subject: string | null): string | null {
  if (subject === null) {
    return null;
  }
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

function quote(text: string): string {
  return text
    .replace(/\r\n|\r/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\r\n");
}

/**
 * Compose a plain-text reply as the selected identity.
 *
 * `Reply-To` is omitted by default. The `From` header is the sole mailbox of
 * the identity, and the message is ready for identity enforcement and DKIM
 * signing. This builder does not add inbound-only headers.
 */
export function composeReply(input: ComposeReplyInput): string {
  const { domain } = splitCanonicalAddress(input.identity.address);
  const messageId = input.messageId ?? `<${randomUUID()}@${domain}>`;
  const from =
    input.fromDisplayName === undefined
      ? input.identity.address
      : `"${input.fromDisplayName.replace(/["\\]/g, "")}" <${input.identity.address}>`;

  const headers: string[] = [
    `From: ${from}`,
    `To: ${input.to}`,
    `Date: ${new Date(input.now).toUTCString()}`,
    `Message-ID: ${messageId}`,
  ];
  const subject = replySubject(input.subject);
  if (subject !== null) {
    headers.push(`Subject: ${subject}`);
  }
  if (input.originalMessageId !== undefined && input.originalMessageId !== null) {
    headers.push(`In-Reply-To: ${input.originalMessageId}`);
    const references = [...(input.references ?? []), input.originalMessageId];
    headers.push(`References: ${references.join(" ")}`);
  }
  headers.push("MIME-Version: 1.0");
  headers.push("Content-Type: text/plain; charset=utf-8");
  headers.push("Content-Transfer-Encoding: 8bit");

  let body = input.body.replace(/\r\n|\r/g, "\n");
  if (input.quotedText !== undefined && input.quotedText.length > 0) {
    body = `${body}\n\n${quote(input.quotedText)}`;
  }

  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}
