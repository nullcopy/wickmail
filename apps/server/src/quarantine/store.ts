import type { MutableMailStore, StoredMessage } from "../mailstore/adapter.js";
import { QUARANTINE_MAILBOXES } from "./types.js";

/**
 * Find a message's quarantine copy by its stable identity, searching the
 * quarantine mailboxes only. The cached locator is never used to decide where
 * the body lives, so a stale locator cannot hide or misplace a message.
 */
export async function findQuarantineCopy(
  store: MutableMailStore,
  messageId: string,
  mailboxes: readonly string[] = QUARANTINE_MAILBOXES,
): Promise<StoredMessage | undefined> {
  for (const mailbox of mailboxes) {
    const message = await store.getMessageIn(mailbox, messageId);
    if (message !== undefined) {
      return message;
    }
  }
  return undefined;
}
