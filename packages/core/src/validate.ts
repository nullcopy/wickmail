/**
 * Runtime validation for management API payloads.
 *
 * Validators are strict: unknown properties are rejected, so a change to the
 * Rust contract that adds or renames a field fails validation until this
 * package is updated.
 */

import type {
  Alias,
  AliasEvent,
  AliasListResponse,
  AliasState,
  ApiToken,
  AuditDetail,
  AuditEventKind,
  ContractVersion,
  CreateAliasRequest,
  CreateTokenRequest,
  DurationRequest,
  EnableRequest,
  ErrorResponse,
  ExpiryRequest,
  IssuedTokenResponse,
  MailCredentialResponse,
  PasskeyResponse,
  Provenance,
  QuarantineListResponse,
  QuarantineResponse,
  RecoverQuarantineRequest,
  ReplyContext,
  ReplyIdentityDecision,
  ReplyIdentityOption,
  ReplyRequest,
  ReplyResponse,
  RotateMailCredentialResponse,
  Scope,
  SessionInfo,
  SessionResponse,
  SetExpiryRequest,
  SetupRequest,
  TokenListResponse,
  UpdateAliasRequest,
  UserResponse,
} from "./contract.ts";

/** Raised when a payload does not match the client schema. */
export class ValidationError extends Error {
  /** JSON path of the offending value. */
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ValidationError";
    this.path = path;
  }
}

type Parser<T> = (value: unknown, path: string) => T;

function fail(path: string, message: string): never {
  throw new ValidationError(path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const string: Parser<string> = (value, path) => {
  if (typeof value !== "string") fail(path, "expected string");
  return value;
};

const number: Parser<number> = (value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected number");
  return value;
};

const boolean: Parser<boolean> = (value, path) => {
  if (typeof value !== "boolean") fail(path, "expected boolean");
  return value;
};

function nullable<T>(parse: Parser<T>): Parser<T | null> {
  return (value, path) => (value === null ? null : parse(value, path));
}

function arrayOf<T>(parse: Parser<T>): Parser<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) fail(path, "expected array");
    return value.map((item, index) => parse(item, `${path}[${index}]`));
  };
}

function oneOf<T extends string>(...values: readonly T[]): Parser<T> {
  return (value, path) => {
    if (typeof value !== "string" || !values.includes(value as T)) {
      fail(path, `expected one of ${values.join(", ")}`);
    }
    return value as T;
  };
}

function object<T>(fields: { [K in keyof T]: Parser<T[K]> }): Parser<T> {
  const known = new Set(Object.keys(fields));
  return (value, path) => {
    if (!isRecord(value)) fail(path, "expected object");
    for (const key of Object.keys(value)) {
      if (!known.has(key)) fail(`${path}.${key}`, "unknown property");
    }
    const parsers = fields as Record<string, Parser<unknown>>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(parsers)) {
      result[key] = parsers[key](value[key], `${path}.${key}`);
    }
    return result as T;
  };
}

const aliasState: Parser<AliasState> = oneOf("active", "expired", "disabled");

const auditEventKind: Parser<AuditEventKind> = oneOf(
  "created",
  "renewed_by_outbound",
  "manually_renewed",
  "manually_extended",
  "expiry_set",
  "expiry_removed",
  "expired",
  "recovered",
  "replied_as_alias",
  "disabled",
  "enabled",
);

const alias: Parser<Alias> = object<Alias>({
  id: string,
  address: string,
  label: nullable(string),
  purpose: nullable(string),
  state: aliasState,
  createdAt: string,
  expiresAt: nullable(string),
  disabledAt: nullable(string),
  leaseSeconds: number,
  renewOnOutbound: boolean,
  lastInboundAt: nullable(string),
  lastUserActivityAt: nullable(string),
  lastUsedAt: string,
  policyVersion: number,
});

const expiryRequest: Parser<ExpiryRequest> = (value, path) => {
  if (!isRecord(value)) fail(path, "expected object");
  switch (value["mode"]) {
    case "lease":
      return object<{ mode: "lease"; seconds: number | null }>({
        mode: oneOf("lease"),
        seconds: nullable(number),
      })(value, path);
    case "absolute":
      return object<{ mode: "absolute"; expiresAt: string }>({
        mode: oneOf("absolute"),
        expiresAt: string,
      })(value, path);
    case "never":
      return object<{ mode: "never" }>({ mode: oneOf("never") })(value, path);
    default:
      return fail(`${path}.mode`, "expected lease, absolute, or never");
  }
};

const createAliasRequest: Parser<CreateAliasRequest> = object<CreateAliasRequest>({
  label: nullable(string),
  purpose: nullable(string),
  expiry: nullable(expiryRequest),
  renewOnOutbound: nullable(boolean),
});

const updateAliasRequest: Parser<UpdateAliasRequest> = object<UpdateAliasRequest>({
  label: nullable(string),
  purpose: nullable(string),
  renewOnOutbound: nullable(boolean),
});

const durationRequest: Parser<DurationRequest> = object<DurationRequest>({
  seconds: nullable(number),
});

const setExpiryRequest: Parser<SetExpiryRequest> = object<SetExpiryRequest>({
  expiresAt: string,
});

const enableRequest: Parser<EnableRequest> = object<EnableRequest>({
  expiresAt: nullable(string),
});

const aliasListResponse: Parser<AliasListResponse> = object<AliasListResponse>({
  items: arrayOf(alias),
  nextCursor: nullable(string),
});

const auditDetail: Parser<AuditDetail> = object<AuditDetail>({
  previousExpiresAt: nullable(string),
  expiresAt: nullable(string),
  leaseSeconds: nullable(number),
  messageId: nullable(string),
});

const aliasEvent: Parser<AliasEvent> = object<AliasEvent>({
  id: string,
  aliasId: string,
  kind: auditEventKind,
  createdAt: string,
  detail: nullable(auditDetail),
});

const errorResponse: Parser<ErrorResponse> = object<ErrorResponse>({
  code: string,
  message: string,
});

const replyIdentityOption: Parser<ReplyIdentityOption> = (value, path) => {
  if (!isRecord(value)) fail(path, "expected reply identity option");
  switch (value["kind"]) {
    case "alias":
      return object<{ kind: "alias"; aliasId: string; address: string }>({
        kind: oneOf("alias"),
        aliasId: string,
        address: string,
      })(value, path);
    case "primary":
      return object<{ kind: "primary"; address: string }>({
        kind: oneOf("primary"),
        address: string,
      })(value, path);
    default:
      return fail(`${path}.kind`, "expected alias or primary");
  }
};

const replyIdentityDecision: Parser<ReplyIdentityDecision> = object<ReplyIdentityDecision>({
  selection: oneOf("default", "prompt"),
  selected: nullable(replyIdentityOption),
  options: arrayOf(replyIdentityOption),
});

const provenance: Parser<Provenance> = object<Provenance>({
  aliasIds: arrayOf(string),
  primaryReceived: boolean,
});

const replyContext: Parser<ReplyContext> = object<ReplyContext>({
  messageId: string,
  from: nullable(string),
  subject: nullable(string),
  text: string,
  originalMessageId: nullable(string),
  provenance,
  identity: replyIdentityDecision,
});

const replyRequest: Parser<ReplyRequest> = object<ReplyRequest>({
  aliasId: nullable(string),
  body: string,
  quotedText: nullable(string),
});

const replyResponse: Parser<ReplyResponse> = object<ReplyResponse>({
  queued: boolean,
  messageId: string,
  identity: replyIdentityOption,
  renewed: boolean,
  expiresAt: nullable(string),
});

const contractVersion: Parser<ContractVersion> = object<ContractVersion>({
  apiContractVersion: string,
});

const scope: Parser<Scope> = oneOf(
  "aliases:read",
  "aliases:write",
  "quarantine:read",
  "quarantine:write",
  "messages:read",
  "messages:reply",
);

const setupRequest: Parser<SetupRequest> = object<SetupRequest>({
  setupToken: string,
  password: string,
});

const userResponse: Parser<UserResponse> = object<UserResponse>({
  id: string,
  username: string,
  primaryAddress: string,
  createdAt: string,
  setupCompleted: boolean,
  passwordChangedAt: nullable(string),
});

const sessionInfo: Parser<SessionInfo> = object<SessionInfo>({
  id: string,
  createdAt: string,
  lastUsedAt: string,
  expiresAt: string,
});

const sessionResponse: Parser<SessionResponse> = object<SessionResponse>({
  session: sessionInfo,
  csrfToken: string,
});

const createTokenRequest: Parser<CreateTokenRequest> = object<CreateTokenRequest>({
  name: string,
  scopes: arrayOf(scope),
  expiresAt: nullable(string),
});

const apiToken: Parser<ApiToken> = object<ApiToken>({
  id: string,
  name: string,
  prefix: string,
  scopes: arrayOf(scope),
  createdAt: string,
  expiresAt: nullable(string),
  revokedAt: nullable(string),
  lastUsedAt: nullable(string),
});

const issuedTokenResponse: Parser<IssuedTokenResponse> = object<IssuedTokenResponse>({
  token: string,
  record: apiToken,
});

const tokenListResponse: Parser<TokenListResponse> = object<TokenListResponse>({
  items: arrayOf(apiToken),
});

const quarantineKind: Parser<QuarantineResponse["kind"]> = oneOf("lease", "spam");

const quarantineStatus: Parser<QuarantineResponse["status"]> = oneOf(
  "quarantined",
  "recovering",
  "recovered",
  "deleting",
  "deleted",
);

const quarantineResponse: Parser<QuarantineResponse> = object<QuarantineResponse>({
  messageId: string,
  kind: quarantineKind,
  status: quarantineStatus,
  aliasIds: arrayOf(string),
  sender: string,
  subject: string,
  receivedAt: string,
  quarantineExpiresAt: string,
  sizeBytes: number,
  deleteReason: nullable(string),
  createdAt: string,
  updatedAt: string,
  recoveredAt: nullable(string),
  deletedAt: nullable(string),
  preview: nullable(string),
});

const quarantineListResponse: Parser<QuarantineListResponse> = object<QuarantineListResponse>({
  items: arrayOf(quarantineResponse),
  nextCursor: nullable(string),
});

const recoverQuarantineRequest: Parser<RecoverQuarantineRequest> = object<RecoverQuarantineRequest>(
  {
    renew: nullable(boolean),
    enable: nullable(boolean),
  },
);

const mailCredentialResponse: Parser<MailCredentialResponse> = object<MailCredentialResponse>({
  configured: boolean,
  createdAt: nullable(string),
  rotatedAt: nullable(string),
  revokedAt: nullable(string),
});

const rotateMailCredentialResponse: Parser<RotateMailCredentialResponse> =
  object<RotateMailCredentialResponse>({
    credential: mailCredentialResponse,
    password: string,
  });

const passkeyResponse: Parser<PasskeyResponse> = object<PasskeyResponse>({
  id: string,
  name: string,
  createdAt: string,
  lastUsedAt: nullable(string),
});

/** Validates an alias payload. */
export function parseAlias(value: unknown, path = "$"): Alias {
  return alias(value, path);
}

/** Validates an alias list payload. */
export function parseAliasListResponse(value: unknown, path = "$"): AliasListResponse {
  return aliasListResponse(value, path);
}

/** Validates a create-alias request payload. */
export function parseCreateAliasRequest(value: unknown, path = "$"): CreateAliasRequest {
  return createAliasRequest(value, path);
}

/** Validates an update-alias request payload. */
export function parseUpdateAliasRequest(value: unknown, path = "$"): UpdateAliasRequest {
  return updateAliasRequest(value, path);
}

/** Validates a renew or extend request payload. */
export function parseDurationRequest(value: unknown, path = "$"): DurationRequest {
  return durationRequest(value, path);
}

/** Validates a set-expiry request payload. */
export function parseSetExpiryRequest(value: unknown, path = "$"): SetExpiryRequest {
  return setExpiryRequest(value, path);
}

/** Validates an enable request payload. */
export function parseEnableRequest(value: unknown, path = "$"): EnableRequest {
  return enableRequest(value, path);
}

/** Validates an audit event payload. */
export function parseAliasEvent(value: unknown, path = "$"): AliasEvent {
  return aliasEvent(value, path);
}

/** Validates an error envelope payload. */
export function parseErrorResponse(value: unknown, path = "$"): ErrorResponse {
  return errorResponse(value, path);
}

/** Validates a reply-context payload. */
export function parseReplyContext(value: unknown, path = "$"): ReplyContext {
  return replyContext(value, path);
}

/** Validates a reply request payload. */
export function parseReplyRequest(value: unknown, path = "$"): ReplyRequest {
  return replyRequest(value, path);
}

/** Validates a reply response payload. */
export function parseReplyResponse(value: unknown, path = "$"): ReplyResponse {
  return replyResponse(value, path);
}

/** Validates the contract-version payload. */
export function parseContractVersion(value: unknown, path = "$"): ContractVersion {
  return contractVersion(value, path);
}

/** Validates a setup request payload. */
export function parseSetupRequest(value: unknown, path = "$"): SetupRequest {
  return setupRequest(value, path);
}

/** Validates a user payload. */
export function parseUserResponse(value: unknown, path = "$"): UserResponse {
  return userResponse(value, path);
}

/** Validates a session payload. */
export function parseSessionResponse(value: unknown, path = "$"): SessionResponse {
  return sessionResponse(value, path);
}

/** Validates a create-token request payload. */
export function parseCreateTokenRequest(value: unknown, path = "$"): CreateTokenRequest {
  return createTokenRequest(value, path);
}

/** Validates an issued-token payload. */
export function parseIssuedTokenResponse(value: unknown, path = "$"): IssuedTokenResponse {
  return issuedTokenResponse(value, path);
}

/** Validates a token list payload. */
export function parseTokenListResponse(value: unknown, path = "$"): TokenListResponse {
  return tokenListResponse(value, path);
}

/** Validates a quarantine payload. */
export function parseQuarantineResponse(value: unknown, path = "$"): QuarantineResponse {
  return quarantineResponse(value, path);
}

/** Validates a quarantine list payload. */
export function parseQuarantineListResponse(value: unknown, path = "$"): QuarantineListResponse {
  return quarantineListResponse(value, path);
}

/** Validates a recover-quarantine request payload. */
export function parseRecoverQuarantineRequest(
  value: unknown,
  path = "$",
): RecoverQuarantineRequest {
  return recoverQuarantineRequest(value, path);
}

/** Validates a mail-credential payload. */
export function parseMailCredentialResponse(value: unknown, path = "$"): MailCredentialResponse {
  return mailCredentialResponse(value, path);
}

/** Validates a rotate-mail-credential payload. */
export function parseRotateMailCredentialResponse(
  value: unknown,
  path = "$",
): RotateMailCredentialResponse {
  return rotateMailCredentialResponse(value, path);
}

/** Validates a passkey payload. */
export function parsePasskeyResponse(value: unknown, path = "$"): PasskeyResponse {
  return passkeyResponse(value, path);
}
