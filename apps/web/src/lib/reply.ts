/**
 * Reply composer logic: subject threading, identity selection, and error
 * guidance. Identity options and the default come from the server's
 * reply-context decision; the client never invents an identity.
 */

import type { ReplyContext, ReplyIdentityOption } from "@wickmail/core";
import { ApiError } from "./errors.ts";

/** A stable key for a reply identity, usable in a select. */
export function identityKey(option: ReplyIdentityOption): string {
  return option.kind === "alias" ? `alias:${option.aliasId}` : "primary";
}

/** A user-facing label for a reply identity. */
export function identityLabel(option: ReplyIdentityOption): string {
  return option.kind === "alias" ? option.address : `${option.address} (primary)`;
}

/** Prefills the subject as a reply without double-prefixing. */
export function replySubject(subject: string | null): string {
  const base = subject?.trim() ?? "";
  if (!base) return "Re:";
  return /^re:\s/i.test(base) ? base : `Re: ${base}`;
}

/** The alias id to send as, or null for the primary identity. */
export function aliasIdFor(option: ReplyIdentityOption | null): string | null {
  return option?.kind === "alias" ? option.aliasId : null;
}

/** The request fields that select a sending identity. */
export function identitySelection(option: ReplyIdentityOption | null): {
  aliasId: string | null;
  primary: boolean | null;
} {
  if (option?.kind === "alias") return { aliasId: option.aliasId, primary: null };
  if (option?.kind === "primary") return { aliasId: null, primary: true };
  return { aliasId: null, primary: null };
}

/** The default identity key, or null when the user must choose. */
export function defaultIdentityKey(context: ReplyContext): string | null {
  return context.identity.selected ? identityKey(context.identity.selected) : null;
}

/** True when several aliases received the message and a choice is required. */
export function requiresIdentityChoice(context: ReplyContext): boolean {
  return context.identity.selection === "prompt";
}

/** Finds an option by its select key. */
export function findIdentity(
  context: ReplyContext,
  key: string | null,
): ReplyIdentityOption | null {
  if (key === null) return null;
  return context.identity.options.find((option) => identityKey(option) === key) ?? null;
}

/** The identities a rejected identity can be replaced with. */
export function identityAlternatives(
  context: ReplyContext,
  rejected: ReplyIdentityOption | null,
): ReplyIdentityOption[] {
  if (!rejected) return context.identity.options;
  return context.identity.options.filter((option) => identityKey(option) !== identityKey(rejected));
}

/** Guidance shown after a failed reply submission. */
export interface ReplyErrorGuidance {
  title: string;
  detail: string;
}

/** Maps a failed reply to guidance that names the problem and next step. */
export function replyErrorGuidance(
  error: unknown,
  rejected: ReplyIdentityOption | null = null,
): ReplyErrorGuidance {
  if (!(error instanceof ApiError)) {
    return { title: "Reply not sent", detail: "The reply could not be sent. Try again." };
  }
  if (error.isOffline) {
    return {
      title: "Reply not sent",
      detail: "The server could not be reached. Your message is preserved; try again.",
    };
  }
  switch (error.code) {
    case "identity_required":
      return {
        title: "Choose a sending identity",
        detail:
          "Several aliases received this message. Choose the alias to reply as, then send again.",
      };
    case "forbidden":
      return {
        title: "Identity not allowed",
        detail: rejected
          ? `The server rejected ${identityLabel(rejected)} for this message. Choose one of the offered identities and try again.`
          : "The selected identity was rejected. Choose one of the offered identities and try again.",
      };
    case "reply_rejected":
      return {
        title: "Reply rejected",
        detail: error.message,
      };
    case "no_sender":
      return {
        title: "Reply rejected",
        detail: "The original message has no usable sender to reply to.",
      };
    case "alias_not_found":
      return {
        title: "Alias unavailable",
        detail: "The selected alias no longer exists. Choose another identity.",
      };
    case "message_not_found":
      return {
        title: "Message unavailable",
        detail: "The original message is no longer available to reply to.",
      };
    default:
      return { title: "Reply not sent", detail: error.message };
  }
}
