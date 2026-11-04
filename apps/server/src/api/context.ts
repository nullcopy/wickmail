import type { FastifyRequest } from "fastify";
import type { ApiScope } from "wickmail-core";
import type { SqliteDatabase } from "../db/database.js";
import {
  authenticateRequest,
  hasScope,
  parseBearerToken,
  verifyCsrfToken,
  type Principal,
  type SessionPrincipal,
} from "../auth/principal.js";
import { csrfFailure, forbidden, unauthorized } from "./errors.js";

/** The session cookie name. */
export const SESSION_COOKIE = "wickmail_session";

/** Resolve the request principal from a bearer token or the session cookie. */
export function resolvePrincipal(
  db: SqliteDatabase,
  request: FastifyRequest,
  now: number,
): Principal | undefined {
  const bearerToken = parseBearerToken(request.headers.authorization);
  const sessionToken = request.cookies?.[SESSION_COOKIE];
  return authenticateRequest(
    db,
    {
      ...(bearerToken !== undefined ? { bearerToken } : {}),
      ...(sessionToken !== undefined ? { sessionToken } : {}),
    },
    now,
  );
}

/** Require an authenticated principal. */
export function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (principal === null || principal === undefined) {
    throw unauthorized();
  }
  return principal;
}

/**
 * Require a browser session. Credential management — tokens, sessions,
 * passkeys, the mail credential, and the password — is only reachable from a
 * session, so a scoped API token can never mint or revoke credentials.
 */
export function requireSessionPrincipal(request: FastifyRequest): SessionPrincipal {
  const principal = requirePrincipal(request);
  if (principal.kind !== "session") {
    throw forbidden("this endpoint requires a browser session");
  }
  return principal;
}

/** Require a scope on the authenticated principal. */
export function requireScope(request: FastifyRequest, scope: ApiScope): Principal {
  const principal = requirePrincipal(request);
  if (!hasScope(principal, scope)) {
    throw forbidden(`missing scope: ${scope}`);
  }
  return principal;
}

/**
 * Require CSRF protection for a cookie-authenticated mutation. Bearer-token
 * requests are exempt because browsers do not attach them automatically.
 */
export function requireCsrf(request: FastifyRequest, principal: Principal): void {
  const header = request.headers["x-csrf-token"];
  const token = Array.isArray(header) ? header[0] : header;
  if (!verifyCsrfToken(principal, token)) {
    throw csrfFailure();
  }
}

/** The `Idempotency-Key` header value, when present. */
export function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  return value === undefined || value.length === 0 ? undefined : value;
}
