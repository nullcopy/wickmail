/**
 * Same-origin management API client.
 *
 * The browser talks to `/v1` on the origin that served the app, so there is no
 * cross-origin credential handling. Responses are validated with the
 * `wickmail-core` schemas, which mirror the Rust server's contract; a mismatch
 * surfaces as a `contract_mismatch` error instead of silently mis-typing data.
 *
 * Authentication is either a `Secure`, `HttpOnly` session cookie (with the
 * CSRF token echoed on mutations) or a bearer token the user entered for this
 * session. Tokens are held in memory only and are never written to browser
 * storage.
 */

import {
  ValidationError,
  parseAlias,
  parseAliasEvent,
  parseAliasListResponse,
  parseApiToken,
  parseErrorResponse,
  parseIssuedTokenResponse,
  parseMailCredentialResponse,
  parseMessageListResponse,
  parseQuarantineListResponse,
  parseQuarantineResponse,
  parseReplyContext,
  parseReplyResponse,
  parseRotateMailCredentialResponse,
  parseSessionResponse,
  parseTokenListResponse,
  parseUserResponse,
  type Alias,
  type AliasEvent,
  type AliasListResponse,
  type ApiToken,
  type CreateAliasRequest,
  type CreateTokenRequest,
  type DurationRequest,
  type IssuedTokenResponse,
  type MailCredentialResponse,
  type MessageListResponse,
  type QuarantineListResponse,
  type QuarantineResponse,
  type ReplyContext,
  type ReplyRequest,
  type ReplyResponse,
  type RotateMailCredentialResponse,
  type SessionResponse,
  type TokenListResponse,
  type UpdateAliasRequest,
  type UserResponse,
} from "@wickmail/core";

import { ApiError } from "./errors.ts";

/** A `fetch` implementation, injectable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

interface RequestOptions<T> {
  query?: Record<string, unknown>;
  body?: unknown;
  parse: (data: unknown) => T;
}

/** Filters for `GET /v1/aliases`. */
export interface AliasListQuery {
  states?: string[];
  search?: string;
  hasExpiry?: boolean;
  expiresBefore?: string;
  expiresAfter?: string;
  sort?: "expires" | "lastUsed" | "created";
  order?: "asc" | "desc";
  limit?: number;
  cursor?: string | null;
}

/** Filters for `GET /v1/quarantine`. */
export interface QuarantineListQuery {
  kind?: "lease" | "spam";
  status?: string;
  aliasId?: string;
  search?: string;
  order?: "asc" | "desc";
  limit?: number;
  cursor?: string | null;
}

/** Filters for `GET /v1/messages`. */
export interface MessageListQuery {
  aliasId?: string;
  search?: string;
  receivedAfter?: string;
  receivedBefore?: string;
  limit?: number;
  cursor?: string | null;
}

/** The server version endpoint payload. */
export interface VersionInfo {
  product: string;
  version: string;
  apiContractVersion: string;
}

function buildQuery(query?: Record<string, unknown>): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      params.set(key, value.join(","));
    } else {
      params.set(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function parseVersion(data: unknown): VersionInfo {
  if (typeof data !== "object" || data === null) {
    throw new ApiError(200, "invalid_response", "The server returned an unreadable version.");
  }
  const record = data as Record<string, unknown>;
  return {
    product: String(record["product"] ?? ""),
    version: String(record["version"] ?? ""),
    apiContractVersion: String(record["apiContractVersion"] ?? ""),
  };
}

function parseUser(data: unknown): UserResponse {
  if (typeof data !== "object" || data === null || !("user" in data)) {
    throw new ApiError(200, "invalid_response", "The server returned an unreadable user.");
  }
  return parseUserResponse((data as { user: unknown }).user);
}

/** A validated management API client. */
export class ApiClient {
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;

  /** CSRF token echoed on cookie-authenticated mutations. */
  csrfToken: string | null = null;

  /** Bearer token for token-authenticated requests, held in memory only. */
  bearerToken: string | null = null;

  /** Called when an authenticated request is rejected as unauthorized. */
  onUnauthorized: (() => void) | null = null;

  constructor(options: { fetch?: FetchLike; baseUrl?: string } = {}) {
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#baseUrl = options.baseUrl ?? "";
  }

  async #request<T>(method: HttpMethod, path: string, options: RequestOptions<T>): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.bearerToken) headers["Authorization"] = `Bearer ${this.bearerToken}`;
    if (this.csrfToken && method !== "GET") headers["X-CSRF-Token"] = this.csrfToken;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}${buildQuery(options.query)}`, {
        method,
        headers,
        body,
        credentials: "same-origin",
      });
    } catch {
      throw new ApiError(0, "network", "The server could not be reached.");
    }

    if (response.status === 401 && this.onUnauthorized) {
      this.onUnauthorized();
    }
    if (!response.ok) {
      throw await this.#error(response);
    }
    if (response.status === 204) {
      return undefined as T;
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ApiError(
        response.status,
        "invalid_response",
        "The server returned an unreadable response.",
      );
    }
    try {
      return options.parse(data);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new ApiError(
          response.status,
          "contract_mismatch",
          `The server response did not match the client contract (${error.path}).`,
        );
      }
      throw error;
    }
  }

  async #error(response: Response): Promise<ApiError> {
    try {
      const envelope = parseErrorResponse(await response.json());
      return new ApiError(response.status, envelope.code, envelope.message);
    } catch {
      return new ApiError(
        response.status,
        "http_error",
        `The request failed with status ${response.status}.`,
      );
    }
  }

  // Sessions and setup.

  /** Returns the current session, or fails with 401 when anonymous. */
  getSession(): Promise<SessionResponse> {
    return this.#request("GET", "/v1/session", { parse: parseSessionResponse });
  }

  /** Starts a session with the management password. */
  login(password: string): Promise<SessionResponse> {
    return this.#request("POST", "/v1/sessions", {
      body: { password },
      parse: parseSessionResponse,
    });
  }

  /** Ends the current session. */
  logout(): Promise<void> {
    return this.#request("DELETE", "/v1/session", { parse: () => undefined });
  }

  /** Completes first-run setup with the single-use setup token. */
  completeSetup(setupToken: string, password: string): Promise<UserResponse> {
    return this.#request("POST", "/v1/setup", {
      body: { setupToken, password },
      parse: parseUser,
    });
  }

  /** Recovers the account with a one-time recovery code. */
  recoverAccount(code: string, password: string): Promise<UserResponse> {
    return this.#request("POST", "/v1/recovery", {
      body: { code, password },
      parse: parseUser,
    });
  }

  // Aliases.

  listAliases(query: AliasListQuery = {}): Promise<AliasListResponse> {
    return this.#request("GET", "/v1/aliases", {
      query: {
        state: query.states?.length ? query.states.join(",") : undefined,
        search: query.search,
        hasExpiry: query.hasExpiry,
        expiresBefore: query.expiresBefore,
        expiresAfter: query.expiresAfter,
        sort: query.sort,
        order: query.order,
        limit: query.limit,
        cursor: query.cursor,
      },
      parse: parseAliasListResponse,
    });
  }

  createAlias(request: CreateAliasRequest): Promise<Alias> {
    return this.#request("POST", "/v1/aliases", { body: request, parse: parseAlias });
  }

  getAlias(id: string): Promise<Alias> {
    return this.#request("GET", `/v1/aliases/${encodeURIComponent(id)}`, { parse: parseAlias });
  }

  updateAlias(id: string, request: UpdateAliasRequest): Promise<Alias> {
    return this.#request("PATCH", `/v1/aliases/${encodeURIComponent(id)}`, {
      body: request,
      parse: parseAlias,
    });
  }

  renewAlias(id: string, request: DurationRequest = { seconds: null }): Promise<Alias> {
    return this.#request("POST", `/v1/aliases/${encodeURIComponent(id)}/renew`, {
      body: request,
      parse: parseAlias,
    });
  }

  extendAlias(id: string, request: DurationRequest = { seconds: null }): Promise<Alias> {
    return this.#request("POST", `/v1/aliases/${encodeURIComponent(id)}/extend`, {
      body: request,
      parse: parseAlias,
    });
  }

  setAliasExpiry(id: string, expiresAt: string): Promise<Alias> {
    return this.#request("POST", `/v1/aliases/${encodeURIComponent(id)}/expiry`, {
      body: { expiresAt },
      parse: parseAlias,
    });
  }

  removeAliasExpiry(id: string): Promise<Alias> {
    return this.#request("DELETE", `/v1/aliases/${encodeURIComponent(id)}/expiry`, {
      parse: parseAlias,
    });
  }

  disableAlias(id: string): Promise<Alias> {
    return this.#request("POST", `/v1/aliases/${encodeURIComponent(id)}/disable`, {
      parse: parseAlias,
    });
  }

  enableAlias(id: string, expiresAt: string | null = null): Promise<Alias> {
    return this.#request("POST", `/v1/aliases/${encodeURIComponent(id)}/enable`, {
      body: { expiresAt },
      parse: parseAlias,
    });
  }

  async listAliasEvents(id: string): Promise<AliasEvent[]> {
    return this.#request("GET", `/v1/aliases/${encodeURIComponent(id)}/events`, {
      parse: (data) => {
        if (!Array.isArray(data)) {
          throw new ApiError(
            200,
            "invalid_response",
            "The server returned an unreadable event list.",
          );
        }
        return data.map((item) => parseAliasEvent(item));
      },
    });
  }

  // Quarantine.

  listQuarantine(query: QuarantineListQuery = {}): Promise<QuarantineListResponse> {
    return this.#request("GET", "/v1/quarantine", {
      query: {
        kind: query.kind,
        status: query.status,
        aliasId: query.aliasId,
        search: query.search,
        order: query.order,
        limit: query.limit,
        cursor: query.cursor,
      },
      parse: parseQuarantineListResponse,
    });
  }

  getQuarantine(id: string): Promise<QuarantineResponse> {
    return this.#request("GET", `/v1/quarantine/${encodeURIComponent(id)}`, {
      parse: parseQuarantineResponse,
    });
  }

  recoverQuarantine(
    id: string,
    options: { renew?: boolean; enable?: boolean } = {},
  ): Promise<QuarantineResponse> {
    return this.#request("POST", `/v1/quarantine/${encodeURIComponent(id)}/recover`, {
      body: { renew: options.renew ?? null, enable: options.enable ?? null },
      parse: parseQuarantineResponse,
    });
  }

  deleteQuarantine(id: string): Promise<QuarantineResponse> {
    return this.#request("POST", `/v1/quarantine/${encodeURIComponent(id)}/delete`, {
      parse: parseQuarantineResponse,
    });
  }

  // Messages and replies.

  listMessages(query: MessageListQuery = {}): Promise<MessageListResponse> {
    return this.#request("GET", "/v1/messages", {
      query: {
        aliasId: query.aliasId,
        search: query.search,
        receivedAfter: query.receivedAfter,
        receivedBefore: query.receivedBefore,
        limit: query.limit,
        cursor: query.cursor,
      },
      parse: parseMessageListResponse,
    });
  }

  getReplyContext(id: string): Promise<ReplyContext> {
    return this.#request("GET", `/v1/messages/${encodeURIComponent(id)}/reply-context`, {
      parse: parseReplyContext,
    });
  }

  sendReply(id: string, request: ReplyRequest): Promise<ReplyResponse> {
    return this.#request("POST", `/v1/messages/${encodeURIComponent(id)}/reply`, {
      body: request,
      parse: parseReplyResponse,
    });
  }

  // Tokens and credentials.

  listTokens(): Promise<TokenListResponse> {
    return this.#request("GET", "/v1/tokens", { parse: parseTokenListResponse });
  }

  createToken(request: CreateTokenRequest): Promise<IssuedTokenResponse> {
    return this.#request("POST", "/v1/tokens", {
      body: request,
      parse: parseIssuedTokenResponse,
    });
  }

  revokeToken(id: string): Promise<ApiToken> {
    return this.#request("DELETE", `/v1/tokens/${encodeURIComponent(id)}`, {
      parse: parseApiToken,
    });
  }

  getMailCredential(): Promise<MailCredentialResponse> {
    return this.#request("GET", "/v1/mail-credential", {
      parse: parseMailCredentialResponse,
    });
  }

  rotateMailCredential(password?: string): Promise<RotateMailCredentialResponse> {
    return this.#request("POST", "/v1/mail-credential", {
      body: password ? { password } : {},
      parse: parseRotateMailCredentialResponse,
    });
  }

  revokeMailCredential(): Promise<MailCredentialResponse> {
    return this.#request("DELETE", "/v1/mail-credential", {
      parse: parseMailCredentialResponse,
    });
  }

  // Server information.

  getVersion(): Promise<VersionInfo> {
    return this.#request("GET", "/v1/version", { parse: parseVersion });
  }
}
