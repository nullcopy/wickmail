import type { ApiScope } from "wickmail-core";
import { ALL_API_SCOPES } from "wickmail-core";
import type { SqliteDatabase } from "../db/database.js";
import { verifyApiToken, type ApiTokenRow } from "./apiTokens.js";
import { verifySession, type SessionRow } from "./sessions.js";
import { tokensEqual } from "./tokens.js";
import { getSoleUser } from "./users.js";

/** A request authenticated by a browser session cookie. */
export interface SessionPrincipal {
  kind: "session";
  userId: string;
  scopes: ApiScope[];
  session: SessionRow;
}

/** A request authenticated by a bearer API token. */
export interface TokenPrincipal {
  kind: "api_token";
  userId: string;
  scopes: ApiScope[];
  token: ApiTokenRow;
}

/** An authenticated request. */
export type Principal = SessionPrincipal | TokenPrincipal;

/** Every scope, as granted to a session cookie. */
export function sessionScopes(): ApiScope[] {
  return [...ALL_API_SCOPES];
}

/** Credentials extracted from a request. */
export interface RequestCredentials {
  /** The raw bearer token from the `Authorization` header, without the scheme. */
  bearerToken?: string;
  /** The raw session token from the session cookie. */
  sessionToken?: string;
}

/**
 * Resolve request credentials to a principal. A bearer token takes precedence
 * over a session cookie; an invalid credential resolves to undefined.
 */
export function authenticateRequest(
  db: SqliteDatabase,
  credentials: RequestCredentials,
  now: number,
): Principal | undefined {
  if (credentials.bearerToken !== undefined && credentials.bearerToken.length > 0) {
    const token = verifyApiToken(db, credentials.bearerToken, now);
    if (token === undefined) {
      return undefined;
    }
    const userId = token.userId ?? getSoleUser(db)?.id;
    if (userId === undefined) {
      return undefined;
    }
    return { kind: "api_token", userId, scopes: token.scopes, token };
  }

  if (credentials.sessionToken !== undefined && credentials.sessionToken.length > 0) {
    const session = verifySession(db, credentials.sessionToken, now);
    if (session === undefined) {
      return undefined;
    }
    return {
      kind: "session",
      userId: session.userId,
      scopes: sessionScopes(),
      session,
    };
  }

  return undefined;
}

/** Whether a principal holds a scope. */
export function hasScope(principal: Principal, scope: ApiScope): boolean {
  return principal.scopes.includes(scope);
}

/**
 * Whether a cookie-authenticated request carries a valid CSRF token. Bearer
 * tokens are not sent automatically by browsers, so they need no CSRF check.
 */
export function verifyCsrfToken(principal: Principal, headerToken: string | undefined): boolean {
  if (principal.kind === "api_token") {
    return true;
  }
  if (headerToken === undefined || headerToken.length === 0) {
    return false;
  }
  return tokensEqual(headerToken, principal.session.csrfToken);
}

/** Extract the raw token from an `Authorization: Bearer <token>` header value. */
export function parseBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? undefined : match[1]!.trim();
}
