/**
 * Client-facing types that mirror the Rust server's management API contract.
 *
 * The server is the source of truth. These types are checked against the
 * server's generated fixtures in `apps/server/crates/wickmail-server/fixtures`
 * by `validate.test.ts`, so drift fails the client tests.
 *
 * This package contains no lease evaluation, expiry derivation, or routing
 * logic. Clients consume the server-computed `state` and raw timestamps.
 */

/** Lifecycle state of an alias, computed by the server. */
export type AliasState = "active" | "expired" | "disabled";

/** Lifecycle transition recorded by the server. */
export type AuditEventKind =
  | "created"
  | "renewed_by_outbound"
  | "manually_renewed"
  | "manually_extended"
  | "expiry_set"
  | "expiry_removed"
  | "expired"
  | "recovered"
  | "replied_as_alias"
  | "disabled"
  | "enabled";

/** Default reply identity derived from message provenance by the server. */
export type ReplyIdentity = { alias: string } | "primary" | "ambiguous" | "none";

/** An alias as returned by the management API. */
export interface Alias {
  id: string;
  address: string;
  label: string | null;
  purpose: string | null;
  /** Server-computed lifecycle state. */
  state: AliasState;
  createdAt: string;
  expiresAt: string | null;
  disabledAt: string | null;
  leaseSeconds: number;
  renewOnOutbound: boolean;
  lastInboundAt: string | null;
  lastUserActivityAt: string | null;
  /** Server-computed last-used time used for sorting. */
  lastUsedAt: string;
  policyVersion: number;
}

/** Response of `GET /v1/aliases`. */
export interface AliasListResponse {
  items: Alias[];
  nextCursor: string | null;
}

/** Initial expiration setting for a new alias. */
export type ExpiryRequest =
  | { mode: "lease"; seconds: number | null }
  | { mode: "absolute"; expiresAt: string }
  | { mode: "never" };

/** Body of `POST /v1/aliases`. */
export interface CreateAliasRequest {
  label: string | null;
  purpose: string | null;
  expiry: ExpiryRequest | null;
  renewOnOutbound: boolean | null;
}

/** Body of `PATCH /v1/aliases/{id}`. */
export interface UpdateAliasRequest {
  label: string | null;
  purpose: string | null;
  renewOnOutbound: boolean | null;
}

/** Body of `POST /v1/aliases/{id}/renew` and `/extend`. */
export interface DurationRequest {
  seconds: number | null;
}

/** Body of `POST /v1/aliases/{id}/expiry`. */
export interface SetExpiryRequest {
  expiresAt: string;
}

/** Body of `POST /v1/aliases/{id}/enable`. */
export interface EnableRequest {
  expiresAt: string | null;
}

/** Structured detail attached to an audit event. */
export interface AuditDetail {
  previousExpiresAt: string | null;
  expiresAt: string | null;
  leaseSeconds: number | null;
  messageId: string | null;
}

/** An audit event as returned by `GET /v1/aliases/{id}/events`. */
export interface AliasEvent {
  id: string;
  aliasId: string;
  kind: AuditEventKind;
  createdAt: string;
  detail: AuditDetail | null;
}

/** Error envelope returned for failed requests. */
export interface ErrorResponse {
  code: string;
  message: string;
}

/** Trusted provenance recorded at inbound acceptance. */
export interface Provenance {
  aliasIds: string[];
  primaryReceived: boolean;
  replyIdentity: ReplyIdentity;
}

/** Response of `GET /v1/messages/{id}/reply-context`. */
export interface ReplyContext {
  messageId: string;
  from: string;
  subject: string;
  text: string;
  provenance: Provenance;
}

/** Body of `POST /v1/messages/{id}/reply`. */
export interface ReplyRequest {
  aliasId: string;
  body: string;
  quotedText: string | null;
}

/** Response of `POST /v1/messages/{id}/reply`. */
export interface ReplyResponse {
  queued: boolean;
  messageId: string;
}

/** The management API contract version mirrored by this client. */
export interface ContractVersion {
  apiContractVersion: string;
}
