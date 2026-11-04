import type { ReplyContext, ReplyIdentity, ReplyRequest } from "wickmail-core";
import { recordAuditEvent } from "../audit/events.js";
import type { SqliteDatabase } from "../db/database.js";
import type { MailStoreAdapter } from "../mailstore/adapter.js";
import { getReplyContext } from "./context.js";
import type { DkimSigner } from "./dkim.js";
import { composeReply } from "./outbound.js";
import type { OutboundQueue } from "./queue.js";
import { submitOutbound, type SubmitOutboundResult } from "./submission.js";

/** Dependencies for a {@link ReplyClient}. */
export interface ReplyClientDeps {
  db: SqliteDatabase;
  mailStore: MailStoreAdapter;
  queue: OutboundQueue;
  /** The primary address, offered as an alternative reply identity. */
  primaryAddress?: string | null;
  /** Primary addresses whose appearance in a header must be stripped. */
  primaryAddresses?: readonly string[];
  /** An optional DKIM signer, called with the identity domain. */
  signer?: DkimSigner;
  /** The time source. Defaults to `Date.now`. */
  now?: () => number;
  /** Generates the queue/message ID. Defaults to a UUIDv7. */
  generateMessageId?: (now: number) => string;
}

type IdentityResolution = { ok: true; identity: ReplyIdentity } | { ok: false; reason: string };

function resolveIdentity(context: ReplyContext, request: ReplyRequest): IdentityResolution {
  const requested = request.aliasId ?? null;
  if (requested !== null) {
    const match = context.identity.options.find(
      (option) => option.kind === "alias" && option.aliasId === requested,
    );
    if (match === undefined) {
      return { ok: false, reason: "selected alias did not receive this message" };
    }
    return { ok: true, identity: match };
  }

  if (context.identity.selected === null) {
    return { ok: false, reason: "multiple aliases received this message; select one" };
  }
  return { ok: true, identity: context.identity.selected };
}

/**
 * The reply test client and CLI backend.
 *
 * It drives reply-context fetch and reply submission through the same server
 * functions the management API will call, so it enforces the same identity,
 * lease, and header rules as any other client.
 */
export class ReplyClient {
  private readonly now: () => number;
  private readonly primaryAddresses: readonly string[];

  constructor(private readonly deps: ReplyClientDeps) {
    this.now = deps.now ?? Date.now;
    this.primaryAddresses =
      deps.primaryAddresses ??
      (deps.primaryAddress === undefined || deps.primaryAddress === null
        ? []
        : [deps.primaryAddress]);
  }

  /** Fetch the sanitized reply context for a message. */
  fetchReplyContext(messageId: string): Promise<ReplyContext | undefined> {
    return getReplyContext({
      db: this.deps.db,
      mailStore: this.deps.mailStore,
      messageId,
      primaryAddress: this.deps.primaryAddress ?? null,
    });
  }

  /** Fetch reply context and submit a reply as the selected identity. */
  async submitReply(messageId: string, request: ReplyRequest): Promise<SubmitOutboundResult> {
    const context = await this.fetchReplyContext(messageId);
    if (context === undefined) {
      return { status: "rejected", reason: "message not found" };
    }

    const resolution = resolveIdentity(context, request);
    if (!resolution.ok) {
      return { status: "rejected", reason: resolution.reason };
    }

    if (context.sender === null) {
      return { status: "rejected", reason: "message has no sender to reply to" };
    }

    const now = this.now();
    const raw = composeReply({
      identity: resolution.identity,
      to: context.sender,
      subject: context.subject,
      originalMessageId: context.originalMessageId,
      body: request.body,
      ...(request.quotedText !== undefined ? { quotedText: request.quotedText } : {}),
      now,
    });

    const result = await submitOutbound(
      {
        db: this.deps.db,
        queue: this.deps.queue,
        ...(this.primaryAddresses.length > 0 ? { primaryAddresses: this.primaryAddresses } : {}),
        ...(this.deps.signer !== undefined ? { signer: this.deps.signer } : {}),
        ...(this.deps.generateMessageId !== undefined
          ? { generateMessageId: this.deps.generateMessageId }
          : {}),
      },
      {
        identity: resolution.identity,
        raw,
        recipients: [context.sender],
        now,
      },
    );

    if (result.status === "queued" && resolution.identity.kind === "alias") {
      recordAuditEvent(this.deps.db, {
        aliasId: resolution.identity.aliasId,
        type: "replied_as_alias",
        occurredAt: now,
        detail: { messageId: result.messageId },
      });
    }

    return result;
  }
}
