import type { MessageLocator } from "wickmail-core";

/** A message read from the mail store. */
export interface StoredMessage {
  /** The trusted `X-Wickmail-Message-ID`, the stable identity. */
  messageId: string;
  /** The mailbox the message currently lives in. */
  mailbox: string;
  /** A cached locator, for fast access only. */
  locator: MessageLocator;
  /** The raw message. */
  raw: string;
  /** Acceptance time in epoch milliseconds. */
  receivedAt: number;
}

/**
 * A metadata-only logger for the mail store. Implementations must never
 * receive message bodies; the adapter only logs message IDs, mailboxes, and
 * locators.
 */
export interface MailStoreLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/** A logger that discards every record. */
export const noopMailStoreLogger: MailStoreLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * The internal mail-store read path used by reply context and quarantine.
 *
 * `Aliases/Expired` is only reachable through this adapter; it is not in the
 * user IMAP namespace. Message identity is always `messageId`; a locator is a
 * cache and is verified against the identity before use.
 */
export interface MailStoreAdapter {
  /** The mailboxes this adapter exposes. */
  listMailboxes(): Promise<string[]>;
  /** Every message in a mailbox, oldest first. */
  listMessages(mailbox: string): Promise<StoredMessage[]>;
  /** Look a message up by its stable identity. */
  getMessage(messageId: string): Promise<StoredMessage | undefined>;
  /** Read the message at a cached locator, without treating it as identity. */
  getMessageByLocator(locator: MessageLocator): Promise<StoredMessage | undefined>;
}

/**
 * Read a message by identity, using a cached locator for speed when present.
 *
 * The locator is only a shortcut: if it points at a different message, the
 * result is discarded and the identity lookup runs instead. Message bodies are
 * never logged.
 */
export async function readMessageByIdentity(
  adapter: MailStoreAdapter,
  messageId: string,
  locator?: MessageLocator,
): Promise<StoredMessage | undefined> {
  if (locator !== undefined) {
    const viaLocator = await adapter.getMessageByLocator(locator);
    if (viaLocator !== undefined && viaLocator.messageId === messageId) {
      return viaLocator;
    }
  }
  return adapter.getMessage(messageId);
}
