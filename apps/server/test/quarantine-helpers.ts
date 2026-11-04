import { wickmailHeader } from "wickmail-core";
import type { SqliteDatabase } from "../src/db/database.js";
import { FakeMailStore } from "../src/mailstore/fake.js";
import {
  recordQuarantinedMessage,
  type RecordQuarantinedMessageInput,
} from "../src/quarantine/repository.js";
import { QUARANTINE_MAILBOX } from "../src/quarantine/types.js";
import { createTestAlias } from "./mail-helpers.js";
import { DAY_MS, NOW } from "./helpers.js";

/** Create real aliases and return their IDs, for metadata that references them. */
export function seedAliases(db: SqliteDatabase, count: number): string[] {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(createTestAlias(db, { address: `alias-${index}@example.com` }).id);
  }
  return ids;
}

/** Input for a seeded quarantined message. */
export interface SeedQuarantineInput {
  messageId: string;
  aliasIds?: string[];
  mailbox?: string;
  receivedAt?: number;
  sender?: string;
  subject?: string;
  body?: string;
  /** Retention window in days from `receivedAt`. Defaults to 30. */
  retentionDays?: number;
}

/** The raw message for a seeded quarantined message, with trusted headers. */
export function quarantineRaw(input: SeedQuarantineInput): string {
  const mailbox = input.mailbox ?? QUARANTINE_MAILBOX;
  const receivedAt = input.receivedAt ?? NOW;
  const lines = [
    `${wickmailHeader.messageId}: ${input.messageId}`,
    ...(input.aliasIds ?? []).map((aliasId) => `${wickmailHeader.aliasId}: ${aliasId}`),
    `${wickmailHeader.route}: ${mailbox}`,
    `${wickmailHeader.receivedAt}: ${new Date(receivedAt).toISOString()}`,
    `From: ${input.sender ?? "sender@example.net"}`,
    `Subject: ${input.subject ?? "Quarantined message"}`,
    "",
    input.body ?? "quarantined body",
  ];
  return lines.join("\r\n");
}

/** Put a quarantined message body in the mail store and record its metadata. */
export function seedQuarantinedMessage(
  db: SqliteDatabase,
  store: FakeMailStore,
  input: SeedQuarantineInput,
): { locator: ReturnType<FakeMailStore["put"]> } {
  const mailbox = input.mailbox ?? QUARANTINE_MAILBOX;
  const receivedAt = input.receivedAt ?? NOW;
  const locator = store.put(mailbox, input.messageId, quarantineRaw(input), receivedAt);
  const record: RecordQuarantinedMessageInput = {
    messageId: input.messageId,
    aliasIds: input.aliasIds ?? [],
    sender: input.sender ?? "sender@example.net",
    subject: input.subject ?? "Quarantined message",
    receivedAt,
    quarantineExpiresAt: receivedAt + (input.retentionDays ?? 30) * DAY_MS,
    mailbox,
    locator,
  };
  recordQuarantinedMessage(db, record);
  return { locator };
}

/** The number of copies of a message across every mailbox. */
export async function copiesOf(store: FakeMailStore, messageId: string): Promise<number> {
  let count = 0;
  for (const mailbox of await store.listMailboxes()) {
    if ((await store.getMessageIn(mailbox, messageId)) !== undefined) {
      count += 1;
    }
  }
  return count;
}
