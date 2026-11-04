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

/** How the default reply identity was chosen by the server. */
export type ReplyIdentitySelection = "default" | "prompt";

/** A concrete reply sending identity. */
export type ReplyIdentityOption =
  { kind: "alias"; aliasId: string; address: string } | { kind: "primary"; address: string };

/** The reply-identity decision for a message's trusted provenance. */
export interface ReplyIdentityDecision {
  selection: ReplyIdentitySelection;
  /** The default identity, or null when the client must prompt. */
  selected: ReplyIdentityOption | null;
  /** The identities the client may offer, in preference order. */
  options: ReplyIdentityOption[];
}

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
}

/** Response of `GET /v1/messages/{id}/reply-context`. */
export interface ReplyContext {
  messageId: string;
  /** Sanitized sender, or null when it cannot be determined. */
  from: string | null;
  /** Sanitized subject, or null when absent. */
  subject: string | null;
  /** Sanitized plain-text body. */
  text: string;
  /** The original RFC 5322 Message-ID, for threading, or null. */
  originalMessageId: string | null;
  provenance: Provenance;
  /** The reply-identity decision derived from provenance and ownership. */
  identity: ReplyIdentityDecision;
}

/** Body of `POST /v1/messages/{id}/reply`. */
export interface ReplyRequest {
  /** Alias to send as, or null for the default identity. */
  aliasId: string | null;
  body: string;
  quotedText: string | null;
}

/** Response of `POST /v1/messages/{id}/reply`. */
export interface ReplyResponse {
  queued: boolean;
  messageId: string;
  /** The identity the reply was sent as. */
  identity: ReplyIdentityOption;
  /** Whether the submission renewed the alias lease. */
  renewed: boolean;
  /** The resulting absolute expiry, or null for no expiry. */
  expiresAt: string | null;
}

/** The management API contract version mirrored by this client. */
export interface ContractVersion {
  apiContractVersion: string;
}
