import type { QuarantineQuota } from "../quarantine/types.js";

/** Per-alias and global quarantine quotas. */
export interface QuarantineQuotaConfig {
  /** Maximum quarantined messages overall. */
  maxMessages?: number;
  /** Maximum total quarantined bytes overall. */
  maxBytes?: number;
  /** Maximum quarantined messages per alias. */
  maxMessagesPerAlias?: number;
}

/** Rate limits, expressed as events per minute. */
export interface RateLimitConfig {
  /** Management authentication attempts per minute, per source. */
  authPerMinute: number;
  /** Inbound messages per minute, globally. */
  inboundGlobalPerMinute: number;
  /** Inbound messages per minute, per envelope sender. */
  inboundPerSenderPerMinute: number;
  /** Outbound submissions per minute, globally. */
  outboundPerMinute: number;
}

/** The abuse controls the server enforces. */
export interface AbuseLimits {
  /** The maximum accepted message size in bytes. */
  maxMessageBytes: number;
  /** Quarantine quotas. */
  quarantine: QuarantineQuotaConfig;
  /** Rate limits. */
  rateLimits: RateLimitConfig;
  /** Free disk bytes below which the server reports a temporary failure. */
  minFreeBytes: number;
}

/** The default message size limit: 25 MiB, matching Postfix's default. */
export const DEFAULT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/** The default free-disk floor: 256 MiB. */
export const DEFAULT_MIN_FREE_BYTES = 256 * 1024 * 1024;

/** The default abuse controls. */
export function defaultAbuseLimits(): AbuseLimits {
  return {
    maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
    quarantine: {
      maxMessages: 5000,
      maxBytes: 2 * 1024 * 1024 * 1024,
      maxMessagesPerAlias: 1000,
    },
    rateLimits: {
      authPerMinute: 10,
      inboundGlobalPerMinute: 600,
      inboundPerSenderPerMinute: 30,
      outboundPerMinute: 60,
    },
    minFreeBytes: DEFAULT_MIN_FREE_BYTES,
  };
}

/** Project the abuse limits onto the quarantine retention quota. */
export function toQuarantineQuota(limits: AbuseLimits): QuarantineQuota {
  return {
    ...(limits.quarantine.maxMessages !== undefined
      ? { maxMessages: limits.quarantine.maxMessages }
      : {}),
    ...(limits.quarantine.maxBytes !== undefined ? { maxBytes: limits.quarantine.maxBytes } : {}),
    ...(limits.quarantine.maxMessagesPerAlias !== undefined
      ? { maxMessagesPerAlias: limits.quarantine.maxMessagesPerAlias }
      : {}),
  };
}
