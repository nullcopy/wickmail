/**
 * `wickmail-core` mirrors the server's management API contract.
 *
 * The Rust server in `apps/server` owns the contract. This package provides the
 * client-facing request and response schemas (`contract.ts`) and runtime
 * validation for API payloads (`validate.ts`). It contains no lease
 * evaluation, expiry derivation, or routing logic: the server computes `state`
 * and `lastUsedAt`, and clients only read them.
 *
 * Drift is guarded by the fixtures in
 * `apps/server/crates/wickmail-server/fixtures`, which the Rust crate generates
 * from its own types and `validate.test.ts` validates here.
 */

export * from "./contract.ts";
export * from "./validate.ts";

import type { Alias } from "./contract.ts";

/**
 * Returns true when the server-computed state is active.
 *
 * This reads the server's decision; it does not derive expiry.
 */
export function isActive(alias: Alias): boolean {
  return alias.state === "active";
}

/**
 * Version of the management API contract this client mirrors.
 *
 * This must equal the server's `API_CONTRACT_VERSION`; the contract fixture
 * test enforces it.
 */
export const API_CONTRACT_VERSION = "1.0.0";
