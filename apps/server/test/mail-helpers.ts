import { createAlias, requireAlias, updateAlias, type AliasRow } from "../src/alias/repository.js";
import type { SqliteDatabase } from "../src/db/database.js";
import { NOW } from "./helpers.js";

/** Input for a test alias. */
export interface TestAliasInput {
  address: string;
  label?: string;
  createdAt?: number;
  expiresAt?: number | null;
  disabledAt?: number | null;
  leaseDurationSeconds?: number;
  renewOnOutbound?: boolean;
}

/** Create an alias for mail-path tests and apply any disablement. */
export function createTestAlias(db: SqliteDatabase, input: TestAliasInput): AliasRow {
  const created = createAlias(db, {
    address: input.address,
    label: input.label ?? "Test Alias",
    createdAt: input.createdAt ?? NOW,
    expiresAt: input.expiresAt === undefined ? null : input.expiresAt,
    leaseDurationSeconds: input.leaseDurationSeconds ?? 3600,
    renewOnOutbound: input.renewOnOutbound ?? true,
  });
  if (input.disabledAt !== undefined && input.disabledAt !== null) {
    updateAlias(db, created.id, { disabledAt: input.disabledAt, bumpPolicyVersion: false });
  }
  return requireAlias(db, created.id);
}
