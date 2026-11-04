import type { MessageLocator, ReplyContext } from "wickmail-core";
import { getAliasById } from "../alias/repository.js";
import type { SqliteDatabase } from "../db/database.js";
import { getHeader } from "../mail/headers.js";
import { readMessageByIdentity, type MailStoreAdapter } from "../mailstore/adapter.js";
import { getProvenance } from "../provenance/repository.js";
import { selectReplyIdentity } from "./identity.js";
import {
  extractTextBody,
  sanitizeHeaderValue,
  sanitizeSender,
  sanitizeSubject,
} from "./sanitize.js";

/** Input for a reply-context fetch. */
export interface ReplyContextOptions {
  db: SqliteDatabase;
  mailStore: MailStoreAdapter;
  /** The trusted `X-Wickmail-Message-ID`. */
  messageId: string;
  /** The primary address offered as an alternative identity, or null. */
  primaryAddress?: string | null;
  /** A cached mail-store locator, for fast access only. */
  locator?: MessageLocator;
}

/**
 * Fetch the sanitized reply context for one message.
 *
 * The fetch is scoped to messages the server accepted: a message without
 * trusted provenance resolves to undefined, and the mail store is only read
 * by the stable message ID. It returns the original sender, subject, sanitized
 * plain-text body, threading message ID, provenance, and identity decision. It
 * does not expose folders, search, or arbitrary headers, and it never logs a
 * message body.
 */
export async function getReplyContext(
  options: ReplyContextOptions,
): Promise<ReplyContext | undefined> {
  const provenance = getProvenance(options.db, options.messageId);
  if (provenance === undefined) {
    return undefined;
  }

  const stored = await readMessageByIdentity(options.mailStore, options.messageId, options.locator);
  if (stored === undefined) {
    return undefined;
  }

  const aliasAddresses = new Map<string, string>();
  for (const aliasId of provenance.aliasIds) {
    const alias = getAliasById(options.db, aliasId);
    if (alias !== undefined) {
      aliasAddresses.set(aliasId, alias.address);
    }
  }

  const originalMessageId = getHeader(stored.raw, "Message-ID");

  return {
    messageId: options.messageId,
    sender: sanitizeSender(stored.raw),
    subject: sanitizeSubject(stored.raw),
    text: extractTextBody(stored.raw),
    originalMessageId:
      originalMessageId === undefined ? null : sanitizeHeaderValue(originalMessageId),
    provenance,
    identity: selectReplyIdentity(provenance, aliasAddresses, options.primaryAddress ?? null),
  };
}
