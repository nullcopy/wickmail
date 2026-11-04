import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageLocator } from "wickmail-core";
import {
  noopMailStoreLogger,
  type MailStoreAdapter,
  type MailStoreLogger,
  type StoredMessage,
} from "./adapter.js";

interface MessageMetadata {
  receivedAt: number;
}

interface MailboxIndex {
  /** `messageId -> uid`. */
  messages: Record<string, number>;
  /** The next uid to assign. */
  nextUid: number;
}

/** Options for a filesystem mail store. */
export interface FileMailStoreOptions {
  /** The mail root; mailboxes are subdirectories. */
  directory: string;
  /** The `UIDVALIDITY` assigned to a mailbox the first time it is created. */
  uidValidity?: number;
  /** A metadata-only logger. */
  logger?: MailStoreLogger;
}

/**
 * A filesystem mail store for the single-host v1 layout. Mailboxes are
 * directories, messages are `<messageId>.eml` files, and a small JSON index
 * assigns a per-mailbox UID for locator caching. Message identity is always
 * the message ID; the index is only a locator.
 */
export class FileMailStore implements MailStoreAdapter {
  private readonly root: string;
  private readonly uidValidity: number;
  private readonly logger: MailStoreLogger;

  constructor(options: FileMailStoreOptions) {
    this.root = options.directory;
    this.uidValidity = options.uidValidity ?? 1;
    this.logger = options.logger ?? noopMailStoreLogger;
    mkdirSync(this.root, { recursive: true });
  }

  private mailboxDirectory(mailbox: string): string {
    return join(this.root, mailbox);
  }

  private index(mailbox: string): MailboxIndex {
    const path = join(this.mailboxDirectory(mailbox), ".index.json");
    if (!existsSync(path)) {
      return { messages: {}, nextUid: 1 };
    }
    return JSON.parse(readFileSync(path, "utf8")) as MailboxIndex;
  }

  private saveIndex(mailbox: string, index: MailboxIndex): void {
    writeFileSync(join(this.mailboxDirectory(mailbox), ".index.json"), JSON.stringify(index));
  }

  private ensureMailbox(mailbox: string): void {
    const directory = this.mailboxDirectory(mailbox);
    mkdirSync(directory, { recursive: true });
    const uidValidityPath = join(directory, ".uidvalidity");
    if (!existsSync(uidValidityPath)) {
      writeFileSync(uidValidityPath, String(this.uidValidity));
    }
  }

  /** Store a message and assign it a UID. Used for ingest and by tests. */
  put(mailbox: string, messageId: string, raw: string, receivedAt: number): MessageLocator {
    this.ensureMailbox(mailbox);
    writeFileSync(join(this.mailboxDirectory(mailbox), `${messageId}.eml`), raw);
    writeFileSync(
      join(this.mailboxDirectory(mailbox), `${messageId}.json`),
      JSON.stringify({ receivedAt } satisfies MessageMetadata),
    );
    const index = this.index(mailbox);
    const uid = index.messages[messageId] ?? index.nextUid;
    index.messages[messageId] = uid;
    index.nextUid = Math.max(index.nextUid, uid + 1);
    this.saveIndex(mailbox, index);
    this.logger.debug("mail store put", { mailbox, messageId, uid });
    return { mailbox, uidValidity: this.uidValidity, uid };
  }

  async listMailboxes(): Promise<string[]> {
    const mailboxes: string[] = [];
    const walk = (directory: string, prefix: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        const child = join(directory, entry.name);
        if (existsSync(join(child, ".index.json"))) {
          mailboxes.push(relative);
        }
        walk(child, relative);
      }
    };
    walk(this.root, "");
    return mailboxes.sort();
  }

  private readMessage(
    mailbox: string,
    messageId: string,
    locator: MessageLocator,
  ): StoredMessage | undefined {
    const directory = this.mailboxDirectory(mailbox);
    const bodyPath = join(directory, `${messageId}.eml`);
    const metaPath = join(directory, `${messageId}.json`);
    if (!existsSync(bodyPath)) {
      return undefined;
    }
    const metadata: MessageMetadata = existsSync(metaPath)
      ? (JSON.parse(readFileSync(metaPath, "utf8")) as MessageMetadata)
      : { receivedAt: statSync(bodyPath).mtimeMs };
    return {
      messageId,
      mailbox,
      locator,
      raw: readFileSync(bodyPath, "utf8"),
      receivedAt: metadata.receivedAt,
    };
  }

  async getMessage(messageId: string): Promise<StoredMessage | undefined> {
    for (const mailbox of await this.listMailboxes()) {
      const index = this.index(mailbox);
      const uid = index.messages[messageId];
      if (uid !== undefined) {
        return this.readMessage(mailbox, messageId, {
          mailbox,
          uidValidity: this.uidValidity,
          uid,
        });
      }
    }
    return undefined;
  }

  async getMessageByLocator(locator: MessageLocator): Promise<StoredMessage | undefined> {
    const directory = this.mailboxDirectory(locator.mailbox);
    if (!existsSync(directory)) {
      return undefined;
    }
    const index = this.index(locator.mailbox);
    const messageId = Object.keys(index.messages).find(
      (candidate) => index.messages[candidate] === locator.uid,
    );
    if (messageId === undefined) {
      return undefined;
    }
    this.logger.debug("mail store locator read", {
      mailbox: locator.mailbox,
      messageId,
      uid: locator.uid,
    });
    return this.readMessage(locator.mailbox, messageId, locator);
  }

  async listMessages(mailbox: string): Promise<StoredMessage[]> {
    const index = this.index(mailbox);
    const entries = Object.entries(index.messages).sort((left, right) => left[1] - right[1]);
    const messages: StoredMessage[] = [];
    for (const [messageId, uid] of entries) {
      const message = this.readMessage(mailbox, messageId, {
        mailbox,
        uidValidity: this.uidValidity,
        uid,
      });
      if (message !== undefined) {
        messages.push(message);
      }
    }
    return messages;
  }
}
