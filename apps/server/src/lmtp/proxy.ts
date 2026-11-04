import type { AliasState, MailRoute } from "wickmail-core";
import { wickmailHeader } from "wickmail-core";
import { alertDiskFull, noopAlertSink, type AlertSink } from "../abuse/disk.js";
import type { SlidingWindowRateLimiter } from "../abuse/rateLimit.js";
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
import { METRIC } from "../metrics/names.js";
import type { MetricsRegistry } from "../metrics/registry.js";
import { recordInboundAcceptance } from "../provenance/repository.js";
import { SpoolFullError, type Spool } from "../spool/types.js";
import { toIsoTimestamp } from "../time.js";

/** Inbound rate limits, expressed as messages per minute. */
export interface InboundRateLimits {
  /** Messages per minute across every sender. */
  globalPerMinute: number;
  /** Messages per minute from one envelope sender. */
  perSenderPerMinute: number;
}

/** The rate-limit window for inbound messages. */
const INBOUND_RATE_WINDOW_MS = 60_000;

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
  /** An inbound rate limiter. Rate limiting is skipped when absent. */
  rateLimiter?: SlidingWindowRateLimiter;
  /** Inbound rate limits. Required for rate limiting to apply. */
  rateLimits?: InboundRateLimits;
  /** Where operational alerts go. Defaults to discarding them. */
  alerts?: AlertSink;
  /** Where metrics are recorded. Metrics are skipped when absent. */
  metrics?: MetricsRegistry;
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
  private readonly alerts: AlertSink;
  private readonly metrics: MetricsRegistry | undefined;

  constructor(private readonly options: MailProxyOptions) {
    this.localDomains = new Set(options.localDomains.map((domain) => domain.trim().toLowerCase()));
    this.primaryAddresses = new Set(
      (options.primaryAddresses ?? []).map((address) => canonicalizeAddress(address)),
    );
    this.now = options.now ?? Date.now;
    this.generateMessageId = options.generateMessageId ?? ((at) => uuidv7(at));
    this.alerts = options.alerts ?? noopAlertSink;
    this.metrics = options.metrics;
  }

  /** Count a deferred message, by the stage that deferred it. */
  private countTempfail(stage: string): void {
    this.metrics?.increment(
      METRIC.messagesTempfailedTotal.name,
      METRIC.messagesTempfailedTotal.help,
      {
        stage,
      },
    );
  }

  /** Apply the inbound rate limits, returning a temporary-failure reason when exceeded. */
  private checkRateLimits(input: LmtpDeliveryInput): string | undefined {
    const { rateLimiter, rateLimits } = this.options;
    if (rateLimiter === undefined || rateLimits === undefined) {
      return undefined;
    }
    const global = rateLimiter.check(
      "inbound:global",
      rateLimits.globalPerMinute,
      INBOUND_RATE_WINDOW_MS,
    );
    if (!global.allowed) {
      return "global inbound rate limit exceeded";
    }
    const sender = parsePathAddress(input.mailFrom).trim().toLowerCase() || "null";
    const perSender = rateLimiter.check(
      `inbound:sender:${sender}`,
      rateLimits.perSenderPerMinute,
      INBOUND_RATE_WINDOW_MS,
    );
    if (!perSender.allowed) {
      return "sender inbound rate limit exceeded";
    }
    return undefined;
  }

  async deliver(input: LmtpDeliveryInput): Promise<LmtpDeliveryResult> {
    const receivedAt = input.receivedAt ?? this.now();
    const stripped = stripWickmailHeaders(input.data).raw;

    const rateLimited = this.checkRateLimits(input);
    if (rateLimited !== undefined) {
      this.countTempfail("rate_limit");
      return { status: "tempfail", reason: rateLimited };
    }

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
      this.metrics?.increment(METRIC.policyFailuresTotal.name, METRIC.policyFailuresTotal.help, {
        stage: "delivery",
      });
      this.countTempfail("policy");
      return { status: "tempfail", reason: `recipient lookup failed: ${errorText(error)}` };
    }

    if (unresolved.length > 0) {
      // Postfix validated recipients before acceptance, so this is defensive.
      // Alias policy never yields a permanent rejection after acceptance.
      this.metrics?.increment(METRIC.policyFailuresTotal.name, METRIC.policyFailuresTotal.help, {
        stage: "delivery",
      });
      this.countTempfail("recipient");
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
      if (error instanceof SpoolFullError) {
        alertDiskFull(this.alerts, receivedAt, { messageId });
      }
      this.countTempfail("spool");
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
      this.countTempfail("provenance");
      return { status: "tempfail", reason: `provenance write failed: ${errorText(error)}` };
    }

    this.metrics?.increment(METRIC.messagesAcceptedTotal.name, METRIC.messagesAcceptedTotal.help, {
      route,
    });

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
