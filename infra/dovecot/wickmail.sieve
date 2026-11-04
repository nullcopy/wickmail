# Global Sieve script for Wickmail inbound routing.
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
