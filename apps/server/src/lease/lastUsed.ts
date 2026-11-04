/** The fields used for "recently used" sorting. */
export interface LastUsedFields {
  lastInboundAt: number | null;
  lastUserActivityAt: number | null;
  createdAt: number;
}

/**
 * The last-used time for sorting: the later of the last accepted inbound mail
 * and the last user activity. An alias with neither timestamp uses its
 * creation time, so never-used aliases sort deterministically.
 *
 * This is a presentation helper; inbound activity never affects the lease.
 */
export function lastUsedAt(fields: LastUsedFields): number {
  const { lastInboundAt, lastUserActivityAt } = fields;
  if (lastInboundAt === null && lastUserActivityAt === null) {
    return fields.createdAt;
  }
  return Math.max(
    lastInboundAt ?? Number.NEGATIVE_INFINITY,
    lastUserActivityAt ?? Number.NEGATIVE_INFINITY,
  );
}
