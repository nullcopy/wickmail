import type { MailRoute } from "wickmail-core";

/**
 * The Dovecot mailbox a trusted route is filed into. `Aliases/Expired` lives
 * in a hidden namespace that only the internal mail-store adapter reads.
 */
export function routeToMailbox(route: MailRoute): string {
  return route;
}

/**
 * The global Sieve script installed by the NixOS module. It routes on the
 * trusted `X-Wickmail-Route` header that the LMTP proxy adds after stripping
 * client headers.
 *
 * Spam is checked first so actual spam goes to `Spam` regardless of alias
 * state. The final `fileinto "Inbox"` is a fallback for messages without a
 * recognized route.
 */
export function renderGlobalSieveScript(): string {
  return `# Global Sieve script for Wickmail inbound routing.
#
# The LMTP proxy strips every client-supplied X-Wickmail-* header and then adds
# the trusted X-Wickmail-Route header, so this script trusts that header.
require ["fileinto", "mailbox"];

# Actual spam goes to Spam regardless of alias state.
if header :contains "X-Wickmail-Route" "Spam" {
  fileinto :create "Spam";
  stop;
}

# Lease quarantine, outside the user IMAP namespace.
if header :contains "X-Wickmail-Route" "Aliases/Expired" {
  fileinto :create "Aliases/Expired";
  stop;
}

fileinto :create "Inbox";
`;
}
