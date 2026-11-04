import type { Alias, AliasEvent } from "wickmail-core";
import type { AuditEventRecord } from "../audit/events.js";
import type { SqliteDatabase } from "../db/database.js";
import { effectiveState } from "../lease/state.js";
import { toIsoTimestamp } from "../time.js";
import { AliasNotFoundError, getAliasById, listAliases, type AliasRow } from "./repository.js";

/** Thrown when an alias exists but is not owned by the requesting user. */
export class AliasOwnershipError extends Error {
  override name = "AliasOwnershipError";

  constructor(readonly aliasId: string) {
    super(`alias is not owned by the requesting user: ${aliasId}`);
  }
}

/** Whether a user owns an alias. A row with no recorded owner belongs to the sole user. */
export function isAliasOwnedBy(alias: AliasRow, userId: string): boolean {
  return alias.ownerId === null || alias.ownerId === userId;
}

/**
 * Resolve an alias and verify ownership. Throws {@link AliasNotFoundError} for
 * an unknown alias and {@link AliasOwnershipError} for one owned by another
 * user.
 */
export function requireOwnedAlias(db: SqliteDatabase, aliasId: string, userId: string): AliasRow {
  const alias = getAliasById(db, aliasId);
  if (alias === undefined) {
    throw new AliasNotFoundError(aliasId);
  }
  if (!isAliasOwnedBy(alias, userId)) {
    throw new AliasOwnershipError(aliasId);
  }
  return alias;
}

/** Every alias owned by a user, oldest first. */
export function listOwnedAliases(db: SqliteDatabase, userId: string): AliasRow[] {
  return listAliases(db).filter((alias) => isAliasOwnedBy(alias, userId));
}

/** Map a stored alias to the management API wire shape. */
export function toAlias(alias: AliasRow, now: number): Alias {
  return {
    id: alias.id,
    address: alias.address,
    label: alias.label,
    purpose: alias.purpose,
    state: effectiveState(alias, now),
    lease: {
      leaseDurationSeconds: alias.leaseDurationSeconds,
      renewOnOutbound: alias.renewOnOutbound,
    },
    createdAt: toIsoTimestamp(alias.createdAt) ?? "",
    expiresAt: toIsoTimestamp(alias.expiresAt),
    disabledAt: toIsoTimestamp(alias.disabledAt),
    lastInboundAt: toIsoTimestamp(alias.lastInboundAt),
    lastUserActivityAt: toIsoTimestamp(alias.lastUserActivityAt),
    policyVersion: alias.policyVersion,
  };
}

/** Map a stored audit event to the management API wire shape. */
export function toAliasEvent(event: AuditEventRecord): AliasEvent {
  return {
    id: event.id,
    aliasId: event.aliasId,
    type: event.type,
    occurredAt: toIsoTimestamp(event.occurredAt) ?? "",
    detail: event.detail,
  };
}
