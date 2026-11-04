import type { z } from "zod";
import {
  aliasResponseSchema,
  listAliasEventsResponseSchema,
  listAliasesResponseSchema,
  type AliasResponse,
  type AliasSort,
  type CreateAliasRequest,
  type EnableAliasRequest,
  type ExtendAliasRequest,
  type ListAliasEventsResponse,
  type ListAliasesQuery,
  type ListAliasesResponse,
  type RenewAliasRequest,
  type SortOrder,
  type UpdateAliasRequest,
} from "./api.js";
import {
  authenticatedResponseSchema,
  createApiTokenResponseSchema,
  listApiTokensResponseSchema,
  listPasskeysResponseSchema,
  listSessionsResponseSchema,
  mailCredentialResponseSchema,
  recoveryCodesResponseSchema,
  sessionResponseSchema,
  setupResponseSchema,
  type AuthenticatedResponse,
  type ChangePasswordRequest,
  type CreateApiTokenRequest,
  type CreateApiTokenResponse,
  type ListApiTokensResponse,
  type ListPasskeysResponse,
  type ListSessionsResponse,
  type LoginRequest,
  type MailCredentialResponse,
  type RecoverAccountRequest,
  type RecoveryCodesResponse,
  type RotateMailCredentialRequest,
  type SessionResponse,
  type SetupRequest,
  type SetupResponse,
} from "./auth.js";
import { apiErrorSchema } from "./error.js";
import {
  deleteQuarantineResponseSchema,
  listQuarantineResponseSchema,
  quarantineResponseSchema,
  recoverQuarantineResponseSchema,
  type DeleteQuarantineRequest,
  type DeleteQuarantineResponse,
  type ListQuarantineQuery,
  type ListQuarantineResponse,
  type QuarantineResponse,
  type RecoverQuarantineRequest,
  type RecoverQuarantineResponse,
} from "./quarantine.js";
import {
  replyContextSchema,
  replyResultSchema,
  type ReplyContext,
  type ReplyRequest,
  type ReplyResult,
} from "./reply.js";

/** A `fetch`-compatible function. The web app passes the browser's `fetch`. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * An error returned by the management API or raised while reaching it.
 *
 * A transport failure carries status `0` and code `network_error`; the request
 * never reached the server, so callers can present an offline state.
 */
export class ApiClientError extends Error {
  override name = "ApiClientError";

  constructor(
    /** The HTTP status, or `0` for a transport failure. */
    readonly status: number,
    /** The stable machine-readable error code. */
    readonly code: string,
    message: string,
    /** Optional structured details from the error body. */
    readonly details?: unknown,
  ) {
    super(message);
  }

  /** Whether the request never reached the server. */
  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

/** Options for {@link createApiClient}. */
export interface ApiClientOptions {
  /** The API origin. Defaults to the same origin (`""`). */
  baseUrl?: string;
  /** The `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /**
   * Returns the CSRF token for cookie-authenticated mutations. The web app
   * keeps the token in memory only; it is never persisted.
   */
  getCsrfToken?: () => string | null | undefined;
  /** Returns an `Idempotency-Key` for the next mutation, when one is available. */
  getIdempotencyKey?: () => string | undefined;
}

/** The management API client used by the web app and other first-party clients. */
export interface ApiClient {
  /** Fetch the current session, or `null` when unauthenticated. */
  getSession(): Promise<SessionResponse | null>;
  /** Authenticate with a username and password. */
  login(body: LoginRequest): Promise<AuthenticatedResponse>;
  /** Complete first-run setup with a single-use setup token. */
  setup(body: SetupRequest): Promise<SetupResponse>;
  /** End the current session. */
  logout(): Promise<void>;
  /** Recover an account with a one-time recovery code. */
  recoverAccount(body: RecoverAccountRequest): Promise<SetupResponse>;
  /** Change the management password. */
  changePassword(body: ChangePasswordRequest): Promise<void>;
  /** Regenerate one-time recovery codes. */
  createRecoveryCodes(): Promise<RecoveryCodesResponse>;
  /** List active sessions. */
  listSessions(): Promise<ListSessionsResponse>;
  /** Revoke a session by ID. */
  revokeSession(id: string): Promise<void>;
  /** List API tokens. */
  listApiTokens(): Promise<ListApiTokensResponse>;
  /** Create an API token. The secret is returned once. */
  createApiToken(body: CreateApiTokenRequest): Promise<CreateApiTokenResponse>;
  /** Revoke an API token by ID. */
  revokeApiToken(id: string): Promise<void>;
  /** List registered passkeys. */
  listPasskeys(): Promise<ListPasskeysResponse>;
  /** Delete a passkey by ID. */
  deletePasskey(id: string): Promise<void>;
  /** Fetch the mail credential status. */
  getMailCredential(): Promise<MailCredentialResponse>;
  /** Rotate the mail credential. */
  rotateMailCredential(body: RotateMailCredentialRequest): Promise<MailCredentialResponse>;
  /** Revoke the mail credential. */
  revokeMailCredential(): Promise<void>;
  /** List aliases with filtering, sorting, and pagination. */
  listAliases(query?: ListAliasesQuery): Promise<ListAliasesResponse>;
  /** Fetch a single alias. */
  getAlias(id: string): Promise<AliasResponse>;
  /** Create an alias. The server generates the address. */
  createAlias(body: CreateAliasRequest): Promise<AliasResponse>;
  /** Update an alias label, purpose, or renewal policy. */
  updateAlias(id: string, body: UpdateAliasRequest): Promise<AliasResponse>;
  /** Renew an alias. */
  renewAlias(id: string, body?: RenewAliasRequest): Promise<AliasResponse>;
  /** Extend an alias. */
  extendAlias(id: string, body?: ExtendAliasRequest): Promise<AliasResponse>;
  /** Disable an alias. */
  disableAlias(id: string): Promise<AliasResponse>;
  /** Enable an alias. */
  enableAlias(id: string, body?: EnableAliasRequest): Promise<AliasResponse>;
  /** List an alias's lifecycle events. */
  listAliasEvents(id: string): Promise<ListAliasEventsResponse>;
  /** List quarantined messages with filtering and pagination. */
  listQuarantine(query?: ListQuarantineQuery): Promise<ListQuarantineResponse>;
  /** Fetch a single quarantined message. */
  getQuarantine(id: string): Promise<QuarantineResponse>;
  /** Recover a quarantined message, optionally renewing or enabling its aliases. */
  recoverQuarantine(
    id: string,
    body?: RecoverQuarantineRequest,
  ): Promise<RecoverQuarantineResponse>;
  /** Delete a quarantined message. */
  deleteQuarantine(id: string, body?: DeleteQuarantineRequest): Promise<DeleteQuarantineResponse>;
  /** Fetch the sanitized reply context for a message. */
  getReplyContext(id: string): Promise<ReplyContext>;
  /** Submit a reply as the selected identity. */
  submitReply(id: string, body: ReplyRequest): Promise<ReplyResult>;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, unknown>;
  /** Treat a 401 response as `null` instead of throwing. */
  optional?: boolean;
}

/** Sort directions accepted by the alias list. */
export type { AliasSort, SortOrder };

function encodeQuery(query: Record<string, unknown> | undefined): string {
  if (query === undefined) {
    return "";
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "boolean") {
      params.set(key, value ? "true" : "false");
    } else {
      params.set(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

/**
 * Build a management API client.
 *
 * Requests are same-origin by default and always send credentials, so the
 * browser attaches the `HttpOnly` session cookie. Mutations carry the CSRF
 * token and an optional idempotency key. Responses are validated against the
 * shared zod schemas, so the wire contract is defined once.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function request<T>(
    path: string,
    requestOptions: RequestOptions,
    schema?: z.ZodType<T>,
  ): Promise<T> {
    const method = requestOptions.method ?? "GET";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (requestOptions.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (method !== "GET" && method !== "HEAD") {
      const csrf = options.getCsrfToken?.();
      if (csrf !== undefined && csrf !== null && csrf.length > 0) {
        headers["X-CSRF-Token"] = csrf;
      }
      const idempotencyKey = options.getIdempotencyKey?.();
      if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
        headers["Idempotency-Key"] = idempotencyKey;
      }
    }

    const init: RequestInit = {
      method,
      headers,
      credentials: "same-origin",
    };
    if (requestOptions.body !== undefined) {
      init.body = JSON.stringify(requestOptions.body);
    }

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}${encodeQuery(requestOptions.query)}`, init);
    } catch (error) {
      throw new ApiClientError(
        0,
        "network_error",
        error instanceof Error ? error.message : "the request could not be sent",
      );
    }

    if (requestOptions.optional === true && response.status === 401) {
      return null as T;
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(payload);
      if (parsed.success) {
        throw new ApiClientError(
          response.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.details,
        );
      }
      throw new ApiClientError(
        response.status,
        "http_error",
        `request failed (${response.status})`,
      );
    }

    if (schema === undefined) {
      return payload as T;
    }
    const result = schema.safeParse(payload);
    if (!result.success) {
      throw new ApiClientError(
        response.status,
        "invalid_response",
        "the server returned an unexpected response",
        result.error.issues,
      );
    }
    return result.data;
  }

  return {
    async getSession() {
      return request("/v1/auth/session", { optional: true }, sessionResponseSchema);
    },
    login(body) {
      return request("/v1/auth/login", { method: "POST", body }, authenticatedResponseSchema);
    },
    setup(body) {
      return request("/v1/auth/setup", { method: "POST", body }, setupResponseSchema);
    },
    logout() {
      return request("/v1/auth/logout", { method: "POST" });
    },
    recoverAccount(body) {
      return request("/v1/auth/recover", { method: "POST", body }, setupResponseSchema);
    },
    changePassword(body) {
      return request("/v1/auth/password", { method: "POST", body });
    },
    createRecoveryCodes() {
      return request("/v1/auth/recovery-codes", { method: "POST" }, recoveryCodesResponseSchema);
    },
    listSessions() {
      return request("/v1/auth/sessions", {}, listSessionsResponseSchema);
    },
    revokeSession(id) {
      return request(`/v1/auth/sessions/${id}`, { method: "DELETE" });
    },
    listApiTokens() {
      return request("/v1/auth/tokens", {}, listApiTokensResponseSchema);
    },
    createApiToken(body) {
      return request("/v1/auth/tokens", { method: "POST", body }, createApiTokenResponseSchema);
    },
    revokeApiToken(id) {
      return request(`/v1/auth/tokens/${id}`, { method: "DELETE" });
    },
    listPasskeys() {
      return request("/v1/auth/passkeys", {}, listPasskeysResponseSchema);
    },
    deletePasskey(id) {
      return request(`/v1/auth/passkeys/${id}`, { method: "DELETE" });
    },
    getMailCredential() {
      return request("/v1/auth/mail-credential", {}, mailCredentialResponseSchema);
    },
    rotateMailCredential(body) {
      return request(
        "/v1/auth/mail-credential",
        { method: "POST", body },
        mailCredentialResponseSchema,
      );
    },
    revokeMailCredential() {
      return request("/v1/auth/mail-credential", { method: "DELETE" });
    },
    listAliases(query) {
      return request(
        "/v1/aliases",
        { query: query as Record<string, unknown> },
        listAliasesResponseSchema,
      );
    },
    getAlias(id) {
      return request(`/v1/aliases/${id}`, {}, aliasResponseSchema);
    },
    createAlias(body) {
      return request("/v1/aliases", { method: "POST", body }, aliasResponseSchema);
    },
    updateAlias(id, body) {
      return request(`/v1/aliases/${id}`, { method: "PATCH", body }, aliasResponseSchema);
    },
    renewAlias(id, body) {
      return request(
        `/v1/aliases/${id}/renew`,
        { method: "POST", body: body ?? {} },
        aliasResponseSchema,
      );
    },
    extendAlias(id, body) {
      return request(
        `/v1/aliases/${id}/extend`,
        { method: "POST", body: body ?? {} },
        aliasResponseSchema,
      );
    },
    disableAlias(id) {
      return request(
        `/v1/aliases/${id}/disable`,
        { method: "POST", body: {} },
        aliasResponseSchema,
      );
    },
    enableAlias(id, body) {
      return request(
        `/v1/aliases/${id}/enable`,
        { method: "POST", body: body ?? {} },
        aliasResponseSchema,
      );
    },
    listAliasEvents(id) {
      return request(`/v1/aliases/${id}/events`, {}, listAliasEventsResponseSchema);
    },
    listQuarantine(query) {
      return request(
        "/v1/quarantine",
        { query: query as Record<string, unknown> },
        listQuarantineResponseSchema,
      );
    },
    getQuarantine(id) {
      return request(`/v1/quarantine/${id}`, {}, quarantineResponseSchema);
    },
    recoverQuarantine(id, body) {
      return request(
        `/v1/quarantine/${id}/recover`,
        { method: "POST", body: body ?? {} },
        recoverQuarantineResponseSchema,
      );
    },
    deleteQuarantine(id, body) {
      return request(
        `/v1/quarantine/${id}/delete`,
        { method: "POST", body: body ?? {} },
        deleteQuarantineResponseSchema,
      );
    },
    getReplyContext(id) {
      return request(`/v1/messages/${id}/reply-context`, {}, replyContextSchema);
    },
    submitReply(id, body) {
      return request(`/v1/messages/${id}/reply`, { method: "POST", body }, replyResultSchema);
    },
  };
}
