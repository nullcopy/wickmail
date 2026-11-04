import { z } from "zod";
import { idSchema, timestampSchema } from "./primitives.js";
import { createValidator, type Validator } from "./validation.js";

/**
 * The scopes an API token may carry. Session cookies are equivalent to a
 * token holding every scope; a programmatic client is limited to the scopes
 * granted to its token.
 */
export const apiScopeSchema = z.enum([
  "aliases:read",
  "aliases:write",
  "quarantine:read",
  "quarantine:write",
  "messages:read",
  "messages:reply",
]);

/** An API token scope. */
export type ApiScope = z.infer<typeof apiScopeSchema>;

/** Every scope, in a stable order. */
export const ALL_API_SCOPES: readonly ApiScope[] = apiScopeSchema.options;

/** How a request was authenticated. */
export const authMethodSchema = z.enum(["session", "api_token"]);

/** A request authentication method. */
export type AuthMethod = z.infer<typeof authMethodSchema>;

/** The single management user. */
export const userSchema = z.object({
  id: idSchema,
  username: z.string().min(1).max(200),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /** Whether a management password is set. */
  hasPassword: z.boolean(),
  /** How many passkeys are registered. */
  passkeyCount: z.number().int().nonnegative(),
});

/** The management user. */
export type User = z.infer<typeof userSchema>;

/**
 * A server-side session. Sessions are revocable: deleting one or marking it
 * revoked immediately invalidates its cookie.
 */
export const sessionSchema = z.object({
  id: idSchema,
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  lastUsedAt: timestampSchema.nullable(),
  userAgent: z.string().nullable(),
  /** Whether this is the session making the request. */
  current: z.boolean(),
});

/** A server-side session. */
export type Session = z.infer<typeof sessionSchema>;

/** `POST /v1/auth/login` request body. */
export const loginRequestSchema = z
  .object({
    username: z.string().min(1).max(200),
    password: z.string().min(1),
  })
  .strict();

/** `POST /v1/auth/login` request body. */
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** A successful authentication response. `csrfToken` is required for cookie mutations. */
export const authenticatedResponseSchema = z.object({
  user: userSchema,
  session: sessionSchema,
  csrfToken: z.string().min(1),
});

/** A successful authentication response. */
export type AuthenticatedResponse = z.infer<typeof authenticatedResponseSchema>;

/** `GET /v1/auth/session` response body. */
export const sessionResponseSchema = authenticatedResponseSchema;

/** `GET /v1/auth/session` response body. */
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/**
 * `POST /v1/auth/setup` request body. The token is the single-use setup token
 * printed by the local bootstrap CLI; it is consumed on success.
 */
export const setupRequestSchema = z
  .object({
    token: z.string().min(1),
    username: z.string().min(1).max(200).optional(),
    password: z.string().min(12).max(1024),
  })
  .strict();

/** `POST /v1/auth/setup` request body. */
export type SetupRequest = z.infer<typeof setupRequestSchema>;

/** `POST /v1/auth/setup` response body. Recovery codes are shown once. */
export const setupResponseSchema = authenticatedResponseSchema.extend({
  recoveryCodes: z.array(z.string().min(1)),
});

/** `POST /v1/auth/setup` response body. */
export type SetupResponse = z.infer<typeof setupResponseSchema>;

/** `POST /v1/auth/recover` request body. */
export const recoverAccountRequestSchema = z
  .object({
    code: z.string().min(1),
    newPassword: z.string().min(12).max(1024),
  })
  .strict();

/** `POST /v1/auth/recover` request body. */
export type RecoverAccountRequest = z.infer<typeof recoverAccountRequestSchema>;

/** `POST /v1/auth/password` request body. */
export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(12).max(1024),
  })
  .strict();

/** `POST /v1/auth/password` request body. */
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/** `POST /v1/auth/recovery-codes` response body. Codes are shown once. */
export const recoveryCodesResponseSchema = z.object({
  codes: z.array(z.string().min(1)),
});

/** `POST /v1/auth/recovery-codes` response body. */
export type RecoveryCodesResponse = z.infer<typeof recoveryCodesResponseSchema>;

/** An API token as returned by the management API. The secret is never returned again. */
export const apiTokenSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(200),
  scopes: z.array(apiScopeSchema),
  createdAt: timestampSchema,
  expiresAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
  lastUsedAt: timestampSchema.nullable(),
});

/** An API token. */
export type ApiToken = z.infer<typeof apiTokenSchema>;

/** `POST /v1/auth/tokens` request body. */
export const createApiTokenRequestSchema = z
  .object({
    name: z.string().min(1).max(200),
    scopes: z.array(apiScopeSchema).min(1),
    expiresAt: timestampSchema.nullable().optional(),
  })
  .strict();

/** `POST /v1/auth/tokens` request body. */
export type CreateApiTokenRequest = z.infer<typeof createApiTokenRequestSchema>;

/** `POST /v1/auth/tokens` response body. `secret` is shown once and never stored. */
export const createApiTokenResponseSchema = z.object({
  token: apiTokenSchema,
  secret: z.string().min(1),
});

/** `POST /v1/auth/tokens` response body. */
export type CreateApiTokenResponse = z.infer<typeof createApiTokenResponseSchema>;

/** `GET /v1/auth/tokens` response body. */
export const listApiTokensResponseSchema = z.object({ tokens: z.array(apiTokenSchema) });

/** `GET /v1/auth/tokens` response body. */
export type ListApiTokensResponse = z.infer<typeof listApiTokensResponseSchema>;

/** `GET /v1/auth/sessions` response body. */
export const listSessionsResponseSchema = z.object({ sessions: z.array(sessionSchema) });

/** `GET /v1/auth/sessions` response body. */
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;

/** A registered passkey. The credential public key is never returned. */
export const passkeySchema = z.object({
  id: idSchema,
  name: z.string().nullable(),
  createdAt: timestampSchema,
  lastUsedAt: timestampSchema.nullable(),
  transports: z.array(z.string()),
});

/** A registered passkey. */
export type Passkey = z.infer<typeof passkeySchema>;

/** `GET /v1/auth/passkeys` response body. */
export const listPasskeysResponseSchema = z.object({ passkeys: z.array(passkeySchema) });

/** `GET /v1/auth/passkeys` response body. */
export type ListPasskeysResponse = z.infer<typeof listPasskeysResponseSchema>;

/** A WebAuthn ceremony's public options, passed through to the browser. */
export const passkeyOptionsResponseSchema = z.object({ options: z.unknown() });

/** A WebAuthn ceremony's public options. */
export type PasskeyOptionsResponse = z.infer<typeof passkeyOptionsResponseSchema>;

/** `POST /v1/auth/passkeys/registration/verify` request body. */
export const passkeyRegistrationVerifyRequestSchema = z
  .object({
    response: z.unknown(),
    name: z.string().min(1).max(200).optional(),
  })
  .strict();

/** `POST /v1/auth/passkeys/registration/verify` request body. */
export type PasskeyRegistrationVerifyRequest = z.infer<
  typeof passkeyRegistrationVerifyRequestSchema
>;

/** `POST /v1/auth/passkeys/registration/verify` response body. */
export const passkeyRegistrationVerifyResponseSchema = z.object({
  verified: z.literal(true),
  credential: passkeySchema,
});

/** `POST /v1/auth/passkeys/registration/verify` response body. */
export type PasskeyRegistrationVerifyResponse = z.infer<
  typeof passkeyRegistrationVerifyResponseSchema
>;

/** `POST /v1/auth/passkeys/authentication/verify` request body. */
export const passkeyAuthenticationVerifyRequestSchema = z
  .object({ response: z.unknown() })
  .strict();

/** `POST /v1/auth/passkeys/authentication/verify` request body. */
export type PasskeyAuthenticationVerifyRequest = z.infer<
  typeof passkeyAuthenticationVerifyRequestSchema
>;

/** The mail credential, separate from management authentication. */
export const mailCredentialSchema = z.object({
  id: idSchema,
  createdAt: timestampSchema,
  rotatedAt: timestampSchema,
  revokedAt: timestampSchema.nullable(),
});

/** The mail credential. */
export type MailCredential = z.infer<typeof mailCredentialSchema>;

/** `GET /v1/auth/mail-credential` response body. */
export const mailCredentialResponseSchema = z.object({
  credential: mailCredentialSchema.nullable(),
});

/** `GET /v1/auth/mail-credential` response body. */
export type MailCredentialResponse = z.infer<typeof mailCredentialResponseSchema>;

/** `POST /v1/auth/mail-credential` request body. */
export const rotateMailCredentialRequestSchema = z
  .object({ password: z.string().min(12).max(1024) })
  .strict();

/** `POST /v1/auth/mail-credential` request body. */
export type RotateMailCredentialRequest = z.infer<typeof rotateMailCredentialRequestSchema>;

/** Validation helpers for the authentication request and response schemas. */
export const loginRequestValidator: Validator<LoginRequest> = createValidator(loginRequestSchema);
export const authenticatedResponseValidator: Validator<AuthenticatedResponse> = createValidator(
  authenticatedResponseSchema,
);
export const setupRequestValidator: Validator<SetupRequest> = createValidator(setupRequestSchema);
export const setupResponseValidator: Validator<SetupResponse> =
  createValidator(setupResponseSchema);
export const recoverAccountRequestValidator: Validator<RecoverAccountRequest> = createValidator(
  recoverAccountRequestSchema,
);
export const changePasswordRequestValidator: Validator<ChangePasswordRequest> = createValidator(
  changePasswordRequestSchema,
);
export const recoveryCodesResponseValidator: Validator<RecoveryCodesResponse> = createValidator(
  recoveryCodesResponseSchema,
);
export const apiTokenValidator: Validator<ApiToken> = createValidator(apiTokenSchema);
export const createApiTokenRequestValidator: Validator<CreateApiTokenRequest> = createValidator(
  createApiTokenRequestSchema,
);
export const createApiTokenResponseValidator: Validator<CreateApiTokenResponse> = createValidator(
  createApiTokenResponseSchema,
);
export const listApiTokensResponseValidator: Validator<ListApiTokensResponse> = createValidator(
  listApiTokensResponseSchema,
);
export const listSessionsResponseValidator: Validator<ListSessionsResponse> = createValidator(
  listSessionsResponseSchema,
);
export const passkeyValidator: Validator<Passkey> = createValidator(passkeySchema);
export const listPasskeysResponseValidator: Validator<ListPasskeysResponse> = createValidator(
  listPasskeysResponseSchema,
);
export const passkeyOptionsResponseValidator: Validator<PasskeyOptionsResponse> = createValidator(
  passkeyOptionsResponseSchema,
);
export const passkeyRegistrationVerifyRequestValidator: Validator<PasskeyRegistrationVerifyRequest> =
  createValidator(passkeyRegistrationVerifyRequestSchema);
export const passkeyRegistrationVerifyResponseValidator: Validator<PasskeyRegistrationVerifyResponse> =
  createValidator(passkeyRegistrationVerifyResponseSchema);
export const passkeyAuthenticationVerifyRequestValidator: Validator<PasskeyAuthenticationVerifyRequest> =
  createValidator(passkeyAuthenticationVerifyRequestSchema);
export const mailCredentialResponseValidator: Validator<MailCredentialResponse> = createValidator(
  mailCredentialResponseSchema,
);
export const rotateMailCredentialRequestValidator: Validator<RotateMailCredentialRequest> =
  createValidator(rotateMailCredentialRequestSchema);
