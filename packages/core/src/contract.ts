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

/** Trusted route for an accepted message. */
export type MessageRoute = "inbox" | "spam" | "quarantine";

/**
 * Delivery metadata for a recent message as returned by `GET /v1/messages`.
 *
 * This never includes a message body.
 */
export interface Message {
  messageId: string;
  aliasIds: string[];
  primaryReceived: boolean;
  sender: string;
  subject: string;
  receivedAt: string;
  route: MessageRoute;
}

/** Response of `GET /v1/messages`. */
export interface MessageListResponse {
  items: Message[];
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

/** A capability an API token may be granted. */
export type Scope =
  | "aliases:read"
  | "aliases:write"
  | "quarantine:read"
  | "quarantine:write"
  | "messages:read"
  | "messages:reply";

/** Body of `POST /v1/setup`. */
export interface SetupRequest {
  setupToken: string;
  password: string;
}

/** The management user as returned by the API. */
export interface UserResponse {
  id: string;
  username: string;
  primaryAddress: string;
  createdAt: string;
  setupCompleted: boolean;
  passwordChangedAt: string | null;
}

/** A management session. */
export interface SessionInfo {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

/** Response of `POST /v1/sessions` and `GET /v1/session`. */
export interface SessionResponse {
  session: SessionInfo;
  csrfToken: string;
}

/** Body of `POST /v1/tokens`. */
export interface CreateTokenRequest {
  name: string;
  scopes: Scope[];
  expiresAt: string | null;
}

/** An API token as returned by the API. The secret is never included. */
export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

/** Response of `POST /v1/tokens`. The token is shown exactly once. */
export interface IssuedTokenResponse {
  token: string;
  record: ApiToken;
}

/** Response of `GET /v1/tokens`. */
export interface TokenListResponse {
  items: ApiToken[];
}

/** Lease quarantine or spam. */
export type QuarantineKind = "lease" | "spam";

/** Lifecycle status of a quarantined message. */
export type QuarantineStatus = "quarantined" | "recovering" | "recovered" | "deleting" | "deleted";

/** A quarantined message as returned by the API. */
export interface QuarantineResponse {
  messageId: string;
  kind: QuarantineKind;
  status: QuarantineStatus;
  aliasIds: string[];
  sender: string;
  subject: string;
  receivedAt: string;
  quarantineExpiresAt: string;
  sizeBytes: number;
  deleteReason: string | null;
  createdAt: string;
  updatedAt: string;
  recoveredAt: string | null;
  deletedAt: string | null;
  preview: string | null;
}

/** Response of `GET /v1/quarantine`. */
export interface QuarantineListResponse {
  items: QuarantineResponse[];
  nextCursor: string | null;
}

/** Body of `POST /v1/quarantine/{id}/recover`. */
export interface RecoverQuarantineRequest {
  renew: boolean | null;
  enable: boolean | null;
}

/** The mail credential as returned by the API. */
export interface MailCredentialResponse {
  configured: boolean;
  createdAt: string | null;
  rotatedAt: string | null;
  revokedAt: string | null;
}

/** Response of `POST /v1/mail-credential`. The password is shown once. */
export interface RotateMailCredentialResponse {
  credential: MailCredentialResponse;
  password: string;
}

/** A registered passkey as returned by the API. */
export interface PasskeyResponse {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}
