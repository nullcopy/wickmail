import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../db/database.js";
import { canonicalizeAddress, splitCanonicalAddress } from "./canonical.js";
import { generateAlias, type AliasGeneratorOptions } from "./generator.js";

/** A stored alias, joined with its lease policy. */
export interface AliasRow {
  id: string;
  address: string;
  localPart: string;
  domain: string;
  label: string;
  purpose: string | null;
  createdAt: number;
  expiresAt: number | null;
  disabledAt: number | null;
  leaseDurationSeconds: number;
  renewOnOutbound: boolean;
  lastInboundAt: number | null;
  lastUserActivityAt: number | null;
  policyVersion: number;
  /** The owning user, or null for rows created before ownership was recorded. */
  ownerId: string | null;
}

/** Thrown when an alias does not exist. */
export class AliasNotFoundError extends Error {
  override name = "AliasNotFoundError";

  constructor(readonly aliasId: string) {
    super(`alias not found: ${aliasId}`);
  }
}

/** Thrown when an optimistic-concurrency write sees a stale policy version. */
export class PolicyVersionConflictError extends Error {
  override name = "PolicyVersionConflictError";

  constructor(
    readonly aliasId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`alias ${aliasId} has policy version ${actual}, expected ${expected}`);
  }
}

interface AliasQueryRow {
  id: string;
  address: string;
  localPart: string;
  domain: string;
  label: string;
  purpose: string | null;
  createdAt: number;
  expiresAt: number | null;
  disabledAt: number | null;
  leaseDurationSeconds: number;
  renewOnOutbound: number;
  lastInboundAt: number | null;
  lastUserActivityAt: number | null;
  policyVersion: number;
  ownerId: string | null;
}

const SELECT_ALIAS = `
  SELECT
    a.id AS id,
    a.address AS address,
    a.local_part AS localPart,
    a.domain AS domain,
    a.label AS label,
    a.purpose AS purpose,
    a.created_at AS createdAt,
    a.expires_at AS expiresAt,
    a.disabled_at AS disabledAt,
    a.last_inbound_at AS lastInboundAt,
    a.last_user_activity_at AS lastUserActivityAt,
    a.policy_version AS policyVersion,
    a.owner_id AS ownerId,
    p.lease_duration_seconds AS leaseDurationSeconds,
    p.renew_on_outbound AS renewOnOutbound
  FROM aliases a
  JOIN alias_lease_policy p ON p.alias_id = a.id
`;

function mapRow(row: AliasQueryRow): AliasRow {
  return {
    id: row.id,
    address: row.address,
    localPart: row.localPart,
    domain: row.domain,
    label: row.label,
    purpose: row.purpose,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    disabledAt: row.disabledAt,
    leaseDurationSeconds: row.leaseDurationSeconds,
    renewOnOutbound: row.renewOnOutbound === 1,
    lastInboundAt: row.lastInboundAt,
    lastUserActivityAt: row.lastUserActivityAt,
    policyVersion: row.policyVersion,
    ownerId: row.ownerId,
  };
}

/** Input for creating an alias from an already-generated address. */
export interface CreateAliasInput {
  /** The address to store; it is canonicalized before insert. */
  address: string;
  label: string;
  purpose?: string | null;
  createdAt: number;
  expiresAt: number | null;
  leaseDurationSeconds: number;
  renewOnOutbound: boolean;
  /** The owning user; defaults to null for callers that predate ownership. */
  ownerId?: string | null;
}

/** Input for creating an alias with a freshly generated address. */
export interface CreateGeneratedAliasInput {
  domain: string;
  label: string;
  purpose?: string | null;
  createdAt: number;
  expiresAt: number | null;
  leaseDurationSeconds: number;
  renewOnOutbound: boolean;
  /** The owning user. */
  ownerId?: string | null;
  /** Generator tuning, excluding the domain and uniqueness check. */
  generator?: Omit<AliasGeneratorOptions, "domain" | "isTaken">;
}

/** Fields an update may change. */
export interface AliasChanges {
  label?: string;
  purpose?: string | null;
  expiresAt?: number | null;
  disabledAt?: number | null;
  lastInboundAt?: number | null;
  lastUserActivityAt?: number | null;
  leaseDurationSeconds?: number;
  renewOnOutbound?: boolean;
  /** Set to false to leave `policy_version` untouched. Defaults to true. */
  bumpPolicyVersion?: boolean;
}

/** Options for an update. */
export interface UpdateAliasOptions {
  /** Reject the write unless the stored policy version matches. */
  expectedPolicyVersion?: number;
}

/** Fetch an alias by ID, or `undefined` when it does not exist. */
export function getAliasById(db: SqliteDatabase, id: string): AliasRow | undefined {
  const row = db.prepare(`${SELECT_ALIAS} WHERE a.id = ?`).get(id) as AliasQueryRow | undefined;
  return row === undefined ? undefined : mapRow(row);
}

/** List every alias, oldest first, with a stable secondary sort by ID. */
export function listAliases(db: SqliteDatabase): AliasRow[] {
  return (
    db.prepare(`${SELECT_ALIAS} ORDER BY a.created_at ASC, a.id ASC`).all() as AliasQueryRow[]
  ).map(mapRow);
}

/** Fetch an alias by ID, throwing when it does not exist. */
export function requireAlias(db: SqliteDatabase, id: string): AliasRow {
  const row = getAliasById(db, id);
  if (row === undefined) {
    throw new AliasNotFoundError(id);
  }
  return row;
}

/**
 * Look up an alias by address, case-insensitively. The input is canonicalized
 * first, so uppercase, mixed case, and IDN domain spellings match. A tagged
 * address such as `green.farm+tag@example.com` does not match, because plus
 * addressing is not supported in v1.
 */
export function findAliasByAddress(db: SqliteDatabase, address: string): AliasRow | undefined {
  let canonical: string;
  try {
    canonical = canonicalizeAddress(address);
  } catch {
    return undefined;
  }
  const row = db.prepare(`${SELECT_ALIAS} WHERE a.address = ?`).get(canonical) as
    AliasQueryRow | undefined;
  return row === undefined ? undefined : mapRow(row);
}

/** Whether a canonical address is already taken. */
export function aliasAddressExists(db: SqliteDatabase, address: string): boolean {
  return findAliasByAddress(db, address) !== undefined;
}

/** Insert an alias and its lease policy. */
export function createAlias(db: SqliteDatabase, input: CreateAliasInput): AliasRow {
  const canonicalAddress = canonicalizeAddress(input.address);
  const { localPart, domain } = splitCanonicalAddress(canonicalAddress);
  const id = randomUUID();

  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO aliases (
         id, address, local_part, domain, label, purpose,
         created_at, expires_at, disabled_at, last_inbound_at, last_user_activity_at, policy_version,
         owner_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?)`,
    ).run(
      id,
      canonicalAddress,
      localPart,
      domain,
      input.label,
      input.purpose ?? null,
      input.createdAt,
      input.expiresAt,
      input.ownerId ?? null,
    );
    db.prepare(
      `INSERT INTO alias_lease_policy (alias_id, lease_duration_seconds, renew_on_outbound)
       VALUES (?, ?, ?)`,
    ).run(id, input.leaseDurationSeconds, input.renewOnOutbound ? 1 : 0);
  });
  insert();

  return requireAlias(db, id);
}

/**
 * Generate a unique address and insert the alias. The uniqueness check reads
 * the database, so a collision retries against the stored canonical address.
 */
export function createAliasWithGeneratedAddress(
  db: SqliteDatabase,
  input: CreateGeneratedAliasInput,
): AliasRow {
  const generated = generateAlias({
    domain: input.domain,
    isTaken: (address) => aliasAddressExists(db, address),
    ...(input.generator ?? {}),
  });
  return createAlias(db, {
    address: generated.address,
    label: input.label,
    purpose: input.purpose ?? null,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    leaseDurationSeconds: input.leaseDurationSeconds,
    renewOnOutbound: input.renewOnOutbound,
    ownerId: input.ownerId ?? null,
  });
}

/**
 * Apply changes to an alias and its lease policy, bumping `policy_version` by
 * default. The address is never touched, so changing policy never changes the
 * address.
 */
export function updateAlias(
  db: SqliteDatabase,
  id: string,
  changes: AliasChanges,
  options: UpdateAliasOptions = {},
): AliasRow {
  const update = db.transaction(() => {
    const current = requireAlias(db, id);
    if (
      options.expectedPolicyVersion !== undefined &&
      current.policyVersion !== options.expectedPolicyVersion
    ) {
      throw new PolicyVersionConflictError(
        id,
        options.expectedPolicyVersion,
        current.policyVersion,
      );
    }

    const aliasAssignments: string[] = [];
    const aliasValues: Array<string | number | null> = [];
    const setAlias = (column: string, value: string | number | null): void => {
      aliasAssignments.push(`${column} = ?`);
      aliasValues.push(value);
    };

    if (changes.label !== undefined) setAlias("label", changes.label);
    if (changes.purpose !== undefined) setAlias("purpose", changes.purpose);
    if (changes.expiresAt !== undefined) setAlias("expires_at", changes.expiresAt);
    if (changes.disabledAt !== undefined) setAlias("disabled_at", changes.disabledAt);
    if (changes.lastInboundAt !== undefined) setAlias("last_inbound_at", changes.lastInboundAt);
    if (changes.lastUserActivityAt !== undefined) {
      setAlias("last_user_activity_at", changes.lastUserActivityAt);
    }

    const policyAssignments: string[] = [];
    const policyValues: number[] = [];
    if (changes.leaseDurationSeconds !== undefined) {
      policyAssignments.push("lease_duration_seconds = ?");
      policyValues.push(changes.leaseDurationSeconds);
    }
    if (changes.renewOnOutbound !== undefined) {
      policyAssignments.push("renew_on_outbound = ?");
      policyValues.push(changes.renewOnOutbound ? 1 : 0);
    }

    const hasChanges = aliasAssignments.length > 0 || policyAssignments.length > 0;
    if (changes.bumpPolicyVersion !== false && hasChanges) {
      aliasAssignments.push("policy_version = policy_version + 1");
    }
    if (aliasAssignments.length > 0) {
      db.prepare(`UPDATE aliases SET ${aliasAssignments.join(", ")} WHERE id = ?`).run(
        ...aliasValues,
        id,
      );
    }
    if (policyAssignments.length > 0) {
      db.prepare(
        `UPDATE alias_lease_policy SET ${policyAssignments.join(", ")} WHERE alias_id = ?`,
      ).run(...policyValues, id);
    }
  });
  update();

  return requireAlias(db, id);
}
