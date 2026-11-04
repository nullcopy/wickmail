import type { Provenance, ReplyIdentity, ReplyIdentityDecision } from "wickmail-core";

/**
 * Select the reply identity from trusted provenance.
 *
 * - Exactly one receiving alias: that alias is the default, and the primary
 *   identity is offered as an alternative.
 * - Primary only: the primary identity is selected.
 * - Multiple receiving aliases: nothing is selected; the client must prompt.
 *
 * The decision never guesses when more than one alias received the message.
 * Alias addresses come from the management database, so a provenance entry
 * whose alias no longer resolves is omitted rather than invented.
 */
export function selectReplyIdentity(
  provenance: Pick<Provenance, "aliasIds" | "primaryReceived">,
  aliasAddresses: ReadonlyMap<string, string>,
  primaryAddress: string | null,
): ReplyIdentityDecision {
  const aliases: ReplyIdentity[] = [];
  for (const aliasId of provenance.aliasIds) {
    const address = aliasAddresses.get(aliasId);
    if (address !== undefined) {
      aliases.push({ kind: "alias", aliasId, address });
    }
  }

  const primary: ReplyIdentity | null =
    primaryAddress === null ? null : { kind: "primary", address: primaryAddress };

  if (aliases.length === 0) {
    if (primary === null) {
      return { selection: "prompt", selected: null, options: [] };
    }
    return { selection: "default", selected: primary, options: [primary] };
  }

  if (aliases.length === 1) {
    const alias = aliases[0]!;
    return {
      selection: "default",
      selected: alias,
      options: primary === null ? [alias] : [alias, primary],
    };
  }

  return {
    selection: "prompt",
    selected: null,
    options: primary === null ? aliases : [...aliases, primary],
  };
}
