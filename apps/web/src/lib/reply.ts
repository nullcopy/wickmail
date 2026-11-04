import {
  ApiClientError,
  type ReplyContext,
  type ReplyIdentity,
  type ReplyIdentityDecision,
} from "wickmail-core";

/** A stable key for a reply identity option. */
export function identityKey(identity: ReplyIdentity): string {
  return identity.kind === "alias" ? `alias:${identity.aliasId}` : `primary:${identity.address}`;
}

/** A human label for a reply identity option. */
export function identityLabel(identity: ReplyIdentity): string {
  return identity.kind === "alias" ? identity.address : `${identity.address} (primary address)`;
}

/**
 * Whether the composer must ask the user to choose. Multiple receiving aliases
 * always prompt; the server never selects silently.
 */
export function requiresIdentityChoice(decision: ReplyIdentityDecision): boolean {
  return decision.selection === "prompt";
}

/** The identity to preselect, or `null` when the user must choose. */
export function defaultIdentity(decision: ReplyIdentityDecision): ReplyIdentity | null {
  return decision.selected;
}

/** The `aliasId` to send for a chosen identity: null selects the primary. */
export function aliasIdForIdentity(identity: ReplyIdentity): string | null {
  return identity.kind === "alias" ? identity.aliasId : null;
}

/** Build a reply subject, avoiding a doubled `Re:` prefix. */
export function replySubject(subject: string | null): string {
  if (subject === null || subject.trim().length === 0) {
    return "";
  }
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** Quote an original message body as plain text. */
export function quoteOriginal(text: string): string {
  if (text.length === 0) {
    return "";
  }
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

/** The kind of failure a reply submission can produce. */
export type ReplyFailureKind = "identity" | "rejected" | "offline" | "permission" | "unknown";

/** A classified reply submission failure. */
export interface ReplyFailure {
  kind: ReplyFailureKind;
  message: string;
}

const IDENTITY_PATTERNS = [
  "did not receive",
  "select one",
  "does not match",
  "alias not found",
  "identity",
  "multiple aliases",
];

/**
 * Classify a reply submission error.
 *
 * The server reports both a rejected lease and a rejected identity as a
 * conflict, so the message distinguishes an identity problem from a general
 * rejection. A transport failure is reported as offline, and a 403 as a
 * permission problem.
 */
export function classifyReplyFailure(error: unknown): ReplyFailure {
  if (error instanceof ApiClientError) {
    if (error.isNetworkError) {
      return {
        kind: "offline",
        message: "The server could not be reached. Check your connection.",
      };
    }
    if (error.status === 403) {
      return { kind: "permission", message: error.message };
    }
    const lower = error.message.toLowerCase();
    if (IDENTITY_PATTERNS.some((pattern) => lower.includes(pattern))) {
      return { kind: "identity", message: error.message };
    }
    if (error.status === 409 || error.status === 400 || error.status === 503) {
      return { kind: "rejected", message: error.message };
    }
    return { kind: "unknown", message: error.message };
  }
  return {
    kind: "unknown",
    message: error instanceof Error ? error.message : "The reply could not be sent.",
  };
}

/** The identity options offered for a reply context. */
export function identityOptions(context: ReplyContext): ReplyIdentity[] {
  return context.identity.options;
}
