import type { AliasState, MailRoute } from "wickmail-core";
import { wickmailHeader } from "wickmail-core";
import { canonicalizeAddress, splitCanonicalAddress } from "../alias/canonical.js";
import { findAliasByAddress } from "../alias/repository.js";
import type { SqliteDatabase } from "../db/database.js";
import { effectiveState } from "../lease/state.js";
import { addHeaders, stripWickmailHeaders } from "../mail/headers.js";
import {
  crossCheckRecipients,
  parsePathAddress,
  type RecipientCrossCheck,
} from "../mail/envelope.js";
import { chooseRoute } from "../mail/route.js";
import { isSpam } from "../mail/spam.js";
import { uuidv7 } from "../mail/uuidv7.js";
import { recordInboundAcceptance } from "../provenance/repository.js";
import type { Spool } from "../spool/types.js";
import { toIsoTimestamp } from "../time.js";

/** A message handed to the LMTP proxy. */
export interface LmtpDeliveryInput {
  /** The SMTP envelope sender, already unwrapped from angle brackets. */
  mailFrom: string;
  /** The SMTP envelope recipients, already unwrapped. */
  rcptTo: string[];
  /** The raw message data, without the terminating dot. */
  data: string;
  /** The acceptance time in epoch milliseconds. */
  receivedAt: number;
}

/** The outcome of proxying a message. */
export type LmtpDeliveryResult =
  | {
      status: "accepted";
      messageId: string;
      route: MailRoute;
      aliasIds: string[];
      primaryReceived: boolean;
      crossCheck: RecipientCrossCheck;
    }
  | { status: "tempfail"; reason: string };

/** Options for the LMTP proxy. */
export interface MailProxyOptions {
  db: SqliteDatabase;
  spool: Spool;
  /** Domains this server is authoritative for. */
  localDomains: readonly string[];
  /** Primary addresses, canonicalized on construction. */
  primaryAddresses?: readonly string[];
  /** The time source; delivery uses the supplied `receivedAt` when present. */
  now?: () => number;
  /** Generates the trusted message ID. Defaults to a UUIDv7. */
  generateMessageId?: (now: number) => string;
}

/**
 * The Wickmail LMTP proxy.
 *
 * It strips every client-supplied `X-Wickmail-*` header, evaluates alias state
 * at delivery, adds trusted headers, writes the message to the durable spool,
 * records provenance, and only then acknowledges. It never permanently rejects
 * a message for alias policy: alias state only chooses the route.
 */
export class MailProxy {
  private readonly localDomains: ReadonlySet<string>;
  private readonly primaryAddresses: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly generateMessageId: (now: number) => string;

  constructor(private readonly options: MailProxyOptions) {
    this.localDomains = new Set(options.localDomains.map((domain) => domain.trim().toLowerCase()));
    this.primaryAddresses = new Set(
      (options.primaryAddresses ?? []).map((address) => canonicalizeAddress(address)),
    );
    this.now = options.now ?? Date.now;
    this.generateMessageId = options.generateMessageId ?? ((at) => uuidv7(at));
  }

  async deliver(input: LmtpDeliveryInput): Promise<LmtpDeliveryResult> {
    const receivedAt = input.receivedAt ?? this.now();
    const stripped = stripWickmailHeaders(input.data).raw;

    const aliasIds: string[] = [];
    const aliasStates: AliasState[] = [];
    let primaryReceived = false;
    const unresolved: string[] = [];

    try {
      for (const recipient of input.rcptTo) {
        const canonical = canonicalizeAddress(parsePathAddress(recipient));
        if (this.primaryAddresses.has(canonical)) {
          primaryReceived = true;
          continue;
        }
        const alias = findAliasByAddress(this.options.db, canonical);
        if (alias === undefined) {
          unresolved.push(canonical);
          continue;
        }
        if (!aliasIds.includes(alias.id)) {
          aliasIds.push(alias.id);
          aliasStates.push(effectiveState(alias, receivedAt));
        }
      }
    } catch (error) {
      return { status: "tempfail", reason: `recipient lookup failed: ${errorText(error)}` };
    }

    if (unresolved.length > 0) {
      // Postfix validated recipients before acceptance, so this is defensive.
      // Alias policy never yields a permanent rejection after acceptance.
      return { status: "tempfail", reason: `no local recipient for ${unresolved.join(", ")}` };
    }

    const route = chooseRoute({
      spam: isSpam(stripped),
      aliasStates,
      primaryReceived,
    });
    const messageId = this.generateMessageId(receivedAt);
    const envelopeRecipients = input.rcptTo.map((recipient) =>
      canonicalizeAddress(parsePathAddress(recipient)),
    );

    const trusted = [
      { name: wickmailHeader.messageId, value: messageId },
      ...aliasIds.map((aliasId) => ({ name: wickmailHeader.aliasId, value: aliasId })),
      { name: wickmailHeader.route, value: route },
      { name: wickmailHeader.receivedAt, value: toIsoTimestamp(receivedAt) ?? "" },
    ];
    const raw = addHeaders(stripped, trusted);

    try {
      await this.options.spool.enqueue({
        id: messageId,
        mailFrom: parsePathAddress(input.mailFrom),
        rcptTo: envelopeRecipients,
        route,
        aliasIds,
        primaryReceived,
        receivedAt,
        raw,
      });
    } catch (error) {
      return { status: "tempfail", reason: `spool unavailable: ${errorText(error)}` };
    }

    try {
      recordInboundAcceptance(this.options.db, {
        messageId,
        aliasIds,
        primaryReceived,
        envelopeRecipients,
        createdAt: receivedAt,
      });
    } catch (error) {
      await this.options.spool.remove(messageId).catch(() => {});
      return { status: "tempfail", reason: `provenance write failed: ${errorText(error)}` };
    }

    return {
      status: "accepted",
      messageId,
      route,
      aliasIds,
      primaryReceived,
      crossCheck: crossCheckRecipients(envelopeRecipients, stripped),
    };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether an address is in one of the configured local domains. */
export function isLocalDomain(address: string, localDomains: ReadonlySet<string>): boolean {
  try {
    return localDomains.has(splitCanonicalAddress(canonicalizeAddress(address)).domain);
  } catch {
    return false;
  }
}
