import type { MessageLocator } from "wickmail-core";
import type { MailStoreAdapter, StoredMessage } from "./adapter.js";

interface FakeEntry {
  messageId: string;
  mailbox: string;
  raw: string;
  receivedAt: number;
  uid: number;
}

/** An in-memory mail store for tests. */
export class FakeMailStore implements MailStoreAdapter {
  private readonly entries: FakeEntry[] = [];
  private nextUid = 1;

  /** Store a message, returning its locator. */
  put(mailbox: string, messageId: string, raw: string, receivedAt: number): MessageLocator {
    const uid = this.nextUid;
    this.nextUid += 1;
    this.entries.push({ messageId, mailbox, raw, receivedAt, uid });
    return { mailbox, uidValidity: 1, uid };
  }

  async listMailboxes(): Promise<string[]> {
    return [...new Set(this.entries.map((entry) => entry.mailbox))].sort();
  }

  async listMessages(mailbox: string): Promise<StoredMessage[]> {
    return this.entries
      .filter((entry) => entry.mailbox === mailbox)
      .sort((left, right) => left.uid - right.uid)
      .map((entry) => this.toStored(entry));
  }

  async getMessage(messageId: string): Promise<StoredMessage | undefined> {
    const entry = this.entries.find((candidate) => candidate.messageId === messageId);
    return entry === undefined ? undefined : this.toStored(entry);
  }

  async getMessageByLocator(locator: MessageLocator): Promise<StoredMessage | undefined> {
    const entry = this.entries.find(
      (candidate) => candidate.mailbox === locator.mailbox && candidate.uid === locator.uid,
    );
    return entry === undefined ? undefined : this.toStored(entry);
  }

  private toStored(entry: FakeEntry): StoredMessage {
    return {
      messageId: entry.messageId,
      mailbox: entry.mailbox,
      locator: { mailbox: entry.mailbox, uidValidity: 1, uid: entry.uid },
      raw: entry.raw,
      receivedAt: entry.receivedAt,
    };
  }
}
