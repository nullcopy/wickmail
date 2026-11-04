import type { AliasState, MailRoute } from "wickmail-core";

/** The inputs that choose a trusted delivery route. */
export interface RouteInput {
  /** Whether a spam filter classified the message as spam. */
  spam: boolean;
  /** The effective state of each receiving alias at delivery time. */
  aliasStates: readonly AliasState[];
  /** Whether the primary address was an envelope recipient. */
  primaryReceived: boolean;
}

/**
 * Choose the trusted route for a message.
 *
 * Spam wins over alias state, so actual spam is routed to `Spam` regardless of
 * whether an alias is active. Otherwise a message to at least one active alias
 * is delivered to `Inbox`; a message received only by expired or disabled
 * aliases is quarantined in `Aliases/Expired`. A primary-only message goes to
 * `Inbox`.
 */
export function chooseRoute(input: RouteInput): MailRoute {
  if (input.spam) {
    return "Spam";
  }
  if (input.aliasStates.some((state) => state === "active")) {
    return "Inbox";
  }
  if (input.aliasStates.length > 0) {
    return "Aliases/Expired";
  }
  return "Inbox";
}
