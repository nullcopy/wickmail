import type { ReplyIdentity } from "wickmail-core";
import type { SlidingWindowRateLimiter } from "../abuse/rateLimit.js";
import { canonicalizeAddress, splitCanonicalAddress } from "../alias/canonical.js";
import { getAliasById, updateAlias, type AliasChanges } from "../alias/repository.js";
import { recordAuditEvent } from "../audit/events.js";
import type { SqliteDatabase } from "../db/database.js";
import { evaluateOutboundSubmission, type OutboundDecision } from "../lease/actions.js";
import { uuidv7 } from "../mail/uuidv7.js";
import { METRIC } from "../metrics/names.js";
import type { MetricsRegistry } from "../metrics/registry.js";
import type { DkimSigner } from "./dkim.js";
import { enforceOutboundIdentity } from "./outbound.js";
import type { OutboundQueue } from "./queue.js";

/** Input for an authenticated outbound submission. */
export interface SubmitOutboundInput {
  /** The selected sending identity. */
  identity: ReplyIdentity;
  /** The composed message, before signing. */
  raw: string;
  /** The SMTP envelope recipients. */
  recipients: string[];
  /** The SMTP envelope sender; defaults to the identity address. */
  envelopeSender?: string;
  /** The submission time in epoch milliseconds. */
  now: number;
  /** Overrides the generated queue/message ID, for deterministic tests. */
  messageId?: string;
}

/** The outcome of an authenticated outbound submission. */
export type SubmitOutboundResult =
  | {
      status: "queued";
      messageId: string;
      identity: ReplyIdentity;
      /** Whether the alias lease was renewed by this submission. */
      renewed: boolean;
      /** The resulting absolute expiry, or null for no expiry. */
      expiresAt: number | null;
    }
  | { status: "rejected"; reason: string }
  | { status: "tempfail"; reason: string };

/** Dependencies for {@link submitOutbound}. */
export interface OutboundSubmissionDeps {
  db: SqliteDatabase;
  queue: OutboundQueue;
  /** Primary addresses whose appearance in a header must be stripped. */
  primaryAddresses?: readonly string[];
  /** An optional DKIM signer, called with the identity domain. */
  signer?: DkimSigner;
  /** Generates the queue/message ID. Defaults to a UUIDv7. */
  generateMessageId?: (now: number) => string;
  /** An outbound rate limiter. Rate limiting is skipped when absent. */
  rateLimiter?: SlidingWindowRateLimiter;
  /** Outbound submissions per minute. Required for rate limiting to apply. */
  outboundPerMinute?: number;
  /** Where metrics are recorded. Metrics are skipped when absent. */
  metrics?: MetricsRegistry;
}

/** The rate-limit window for outbound submissions. */
const OUTBOUND_RATE_WINDOW_MS = 60_000;

function tryCanonicalize(address: string): string | null {
  try {
    return canonicalizeAddress(address);
  } catch {
    return null;
  }
}

function canonicalizeSafely(address: string): string {
  return tryCanonicalize(address) ?? address.trim().toLowerCase();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Submit an authenticated outbound message.
 *
 * The message is checked before it is queued: the identity must be owned, the
 * lease must permit outbound mail, and the message must pass outbound identity
 * enforcement. Only after the message is accepted and queued does an alias
 * renew, so a later bounce cannot revert the renewal and pre-queue checks
 * never extend a lease. A disabled alias is always rejected.
 */
export async function submitOutbound(
  deps: OutboundSubmissionDeps,
  input: SubmitOutboundInput,
): Promise<SubmitOutboundResult> {
  if (deps.rateLimiter !== undefined && deps.outboundPerMinute !== undefined) {
    const limited = deps.rateLimiter.check(
      "outbound:global",
      deps.outboundPerMinute,
      OUTBOUND_RATE_WINDOW_MS,
    );
    if (!limited.allowed) {
      deps.metrics?.increment(
        METRIC.outboundTempfailedTotal.name,
        METRIC.outboundTempfailedTotal.help,
        { reason: "rate_limit" },
      );
      return { status: "tempfail", reason: "outbound rate limit exceeded" };
    }
  }

  const alias =
    input.identity.kind === "alias" ? getAliasById(deps.db, input.identity.aliasId) : undefined;
  if (input.identity.kind === "alias" && alias === undefined) {
    return { status: "rejected", reason: "alias not found" };
  }

  let senderAddress: string;
  let leaseDecision: OutboundDecision | null = null;
  if (alias !== undefined) {
    if (tryCanonicalize(input.identity.address) !== alias.address) {
      return { status: "rejected", reason: "selected alias does not match the owned alias" };
    }
    leaseDecision = evaluateOutboundSubmission(alias, input.now);
    if (!leaseDecision.accepted) {
      return { status: "rejected", reason: leaseDecision.reason ?? "outbound submission rejected" };
    }
    senderAddress = alias.address;
  } else {
    const primary = tryCanonicalize(input.identity.address);
    if (primary === null) {
      return { status: "rejected", reason: "primary identity is not a valid address" };
    }
    senderAddress = primary;
  }

  const envelopeSender = input.envelopeSender ?? senderAddress;
  const enforcement = enforceOutboundIdentity(input.raw, {
    senderAddress,
    envelopeSender,
    ...(deps.primaryAddresses !== undefined ? { primaryAddresses: deps.primaryAddresses } : {}),
  });
  if (!enforcement.accepted) {
    return { status: "rejected", reason: enforcement.reason };
  }

  let raw = enforcement.raw;
  if (deps.signer !== undefined) {
    const { domain } = splitCanonicalAddress(senderAddress);
    raw = deps.signer(raw, { domain, now: input.now });
  }

  const generateMessageId = deps.generateMessageId ?? ((now: number) => uuidv7(now));
  const messageId = input.messageId ?? generateMessageId(input.now);

  try {
    await deps.queue.enqueue({
      id: messageId,
      aliasId: alias?.id ?? null,
      envelopeSender: canonicalizeSafely(envelopeSender),
      envelopeRecipients: input.recipients.map(canonicalizeSafely),
      raw,
      queuedAt: input.now,
    });
  } catch (error) {
    return { status: "tempfail", reason: `outbound queue unavailable: ${errorText(error)}` };
  }

  if (alias === undefined || leaseDecision === null) {
    return {
      status: "queued",
      messageId,
      identity: input.identity,
      renewed: false,
      expiresAt: null,
    };
  }

  // The alias renews only after the message is accepted and queued.
  const renewed = leaseDecision.expiresAt !== alias.expiresAt;
  const changes: AliasChanges = { lastUserActivityAt: input.now };
  if (renewed) {
    changes.expiresAt = leaseDecision.expiresAt;
  } else {
    changes.bumpPolicyVersion = false;
  }
  updateAlias(deps.db, alias.id, changes);

  if (renewed) {
    recordAuditEvent(deps.db, {
      aliasId: alias.id,
      type: "renewed_by_outbound",
      occurredAt: input.now,
      detail: { expiresAt: leaseDecision.expiresAt },
    });
  }

  return {
    status: "queued",
    messageId,
    identity: { kind: "alias", aliasId: alias.id, address: alias.address },
    renewed,
    expiresAt: renewed ? leaseDecision.expiresAt : alias.expiresAt,
  };
}
