import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import {
  changePasswordRequestSchema,
  createApiTokenRequestSchema,
  loginRequestSchema,
  recoverAccountRequestSchema,
  rotateMailCredentialRequestSchema,
  setupRequestSchema,
  type AuthenticatedResponse,
  type CreateApiTokenResponse,
  type ListApiTokensResponse,
  type ListPasskeysResponse,
  type ListSessionsResponse,
  type MailCredential,
  type MailCredentialResponse,
  type Passkey,
  type RecoveryCodesResponse,
  type SetupResponse,
  type Session,
  type User,
} from "wickmail-core";
import { createApiToken, listApiTokens, revokeApiToken } from "../auth/apiTokens.js";
import {
  getActiveMailCredential,
  revokeMailCredential,
  rotateMailCredential,
} from "../auth/mailCredential.js";
import { argon2idHasher, type PasswordHasher } from "../auth/password.js";
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  deletePasskey,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  listPasskeys,
  type PasskeyConfig,
  type PasskeyRow,
} from "../auth/passkeys.js";
import { consumeRecoveryCode, generateRecoveryCodes } from "../auth/recovery.js";
import {
  createSession,
  listSessions,
  revokeSession,
  revokeUserSessions,
  DEFAULT_SESSION_TTL_MS,
  type SessionRow,
} from "../auth/sessions.js";
import { consumeSetupToken } from "../auth/setup.js";
import {
  getSoleUser,
  getUserById,
  getUserByUsername,
  setPasswordHash,
  updateUsername,
  type UserRow,
} from "../auth/users.js";
import { defaultAbuseLimits } from "../abuse/limits.js";
import { SlidingWindowRateLimiter } from "../abuse/rateLimit.js";
import { METRIC } from "../metrics/names.js";
import { toIsoTimestamp } from "../time.js";
import { SESSION_COOKIE, requireCsrf, requireSessionPrincipal } from "./context.js";
import type { ApiDeps } from "./deps.js";
import { forbidden, notFound, notImplemented, rateLimited, unauthorized } from "./errors.js";

/** The window for authentication rate limiting. */
const AUTH_RATE_WINDOW_MS = 60_000;

function now(deps: ApiDeps): number {
  return (deps.now ?? Date.now)();
}

/** Record a failed authentication attempt for monitoring. */
function countAuthFailure(deps: ApiDeps, method: string): void {
  deps.metrics?.increment(METRIC.authFailuresTotal.name, METRIC.authFailuresTotal.help, { method });
}

function hasherFor(deps: ApiDeps): PasswordHasher {
  return deps.passwordHasher ?? argon2idHasher;
}

function passkeyConfig(deps: ApiDeps): PasskeyConfig {
  if (deps.config.passkeys === undefined) {
    throw notImplemented("passkeys are not configured on this server");
  }
  return deps.config.passkeys;
}

function toUser(deps: ApiDeps, user: UserRow): User {
  return {
    id: user.id,
    username: user.username,
    createdAt: toIsoTimestamp(user.createdAt) ?? "",
    updatedAt: toIsoTimestamp(user.updatedAt) ?? "",
    hasPassword: user.passwordHash !== null,
    passkeyCount: listPasskeys(deps.db, user.id).length,
  };
}

function toSession(session: SessionRow, currentId: string | null): Session {
  return {
    id: session.id,
    createdAt: toIsoTimestamp(session.createdAt) ?? "",
    expiresAt: toIsoTimestamp(session.expiresAt) ?? "",
    lastUsedAt: toIsoTimestamp(session.lastUsedAt),
    userAgent: session.userAgent,
    current: session.id === currentId,
  };
}

function toPasskey(passkey: PasskeyRow): Passkey {
  return {
    id: passkey.id,
    name: passkey.name,
    createdAt: toIsoTimestamp(passkey.createdAt) ?? "",
    lastUsedAt: toIsoTimestamp(passkey.lastUsedAt),
    transports: passkey.transports,
  };
}

function toMailCredential(credential: {
  id: string;
  createdAt: number;
  rotatedAt: number;
  revokedAt: number | null;
}): MailCredential {
  return {
    id: credential.id,
    createdAt: toIsoTimestamp(credential.createdAt) ?? "",
    rotatedAt: toIsoTimestamp(credential.rotatedAt) ?? "",
    revokedAt: toIsoTimestamp(credential.revokedAt),
  };
}

function setSessionCookie(deps: ApiDeps, reply: FastifyReply, token: string): void {
  const ttlMs = deps.config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: deps.config.secureCookies ?? true,
    sameSite: deps.config.sameSite ?? "lax",
    maxAge: Math.floor(ttlMs / 1000),
  });
}

/** Register the `/v1/auth` routes. */
export function registerAuthRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const limiter =
    deps.rateLimiter ??
    new SlidingWindowRateLimiter(deps.now !== undefined ? { now: deps.now } : {});
  const limits = deps.config.limits ?? defaultAbuseLimits();

  function enforceAuthRateLimit(request: FastifyRequest): void {
    const result = limiter.check(
      `auth:${request.ip}`,
      limits.rateLimits.authPerMinute,
      AUTH_RATE_WINDOW_MS,
    );
    if (!result.allowed) {
      countAuthFailure(deps, "rate_limit");
      throw rateLimited(result.retryAfterMs);
    }
  }

  function authenticate(
    deps: ApiDeps,
    user: UserRow,
    request: FastifyRequest,
    reply: FastifyReply,
  ): AuthenticatedResponse {
    const at = now(deps);
    const { session, token } = createSession(deps.db, {
      userId: user.id,
      now: at,
      ...(deps.config.sessionTtlMs !== undefined ? { ttlMs: deps.config.sessionTtlMs } : {}),
      userAgent:
        typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null,
    });
    setSessionCookie(deps, reply, token);
    return {
      user: toUser(deps, user),
      session: toSession(session, session.id),
      csrfToken: session.csrfToken,
    };
  }

  app.post("/v1/auth/setup", async (request, reply) => {
    enforceAuthRateLimit(request);
    const body = setupRequestSchema.parse(request.body ?? {});
    const consumed = consumeSetupToken(deps.db, body.token, now(deps));
    if (consumed === undefined) {
      countAuthFailure(deps, "setup");
      throw unauthorized("setup token is invalid, expired, or already used");
    }
    let user = getUserById(deps.db, consumed.userId);
    if (user === undefined) {
      throw notFound("user for setup token no longer exists");
    }

    const at = now(deps);
    const passwordHash = await hasherFor(deps).hash(body.password);
    if (body.username !== undefined) {
      user = updateUsername(deps.db, user.id, body.username, at);
    }
    user = setPasswordHash(deps.db, user.id, passwordHash, at);
    revokeUserSessions(deps.db, user.id, at);
    const recoveryCodes = generateRecoveryCodes(deps.db, { userId: user.id, now: at });

    const response: SetupResponse = {
      ...authenticate(deps, user, request, reply),
      recoveryCodes,
    };
    reply.status(200).send(response);
  });

  app.post("/v1/auth/login", async (request, reply) => {
    enforceAuthRateLimit(request);
    const body = loginRequestSchema.parse(request.body ?? {});
    const user = getUserByUsername(deps.db, body.username);
    if (user === undefined || user.passwordHash === null) {
      countAuthFailure(deps, "password");
      throw unauthorized("invalid username or password");
    }
    const valid = await hasherFor(deps).verify(user.passwordHash, body.password);
    if (!valid) {
      countAuthFailure(deps, "password");
      throw unauthorized("invalid username or password");
    }
    reply.status(200).send(authenticate(deps, user, request, reply));
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const principal = requireSessionPrincipal(request);
    requireCsrf(request, principal);
    revokeSession(deps.db, principal.session.id, now(deps));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.status(204).send();
  });

  app.get("/v1/auth/session", async (request, reply) => {
    const principal = requireSessionPrincipal(request);
    const user = getUserById(deps.db, principal.userId);
    if (user === undefined) {
      throw unauthorized();
    }
    reply.send({
      user: toUser(deps, user),
      session: toSession(principal.session, principal.session.id),
      csrfToken: principal.session.csrfToken,
    } satisfies AuthenticatedResponse);
  });

  app.post("/v1/auth/password", async (request, reply) => {
    const principal = requireSessionPrincipal(request);
    requireCsrf(request, principal);
    const body = changePasswordRequestSchema.parse(request.body ?? {});
    const user = getUserById(deps.db, principal.userId);
    if (user === undefined || user.passwordHash === null) {
      throw unauthorized();
    }
    const valid = await hasherFor(deps).verify(user.passwordHash, body.currentPassword);
    if (!valid) {
      countAuthFailure(deps, "password_change");
      throw forbidden("current password is incorrect");
    }
    const at = now(deps);
    const passwordHash = await hasherFor(deps).hash(body.newPassword);
    setPasswordHash(deps.db, user.id, passwordHash, at);
    revokeUserSessions(deps.db, user.id, at, principal.session.id);
    reply.status(204).send();
  });

  app.post("/v1/auth/recover", async (request, reply) => {
    enforceAuthRateLimit(request);
    const body = recoverAccountRequestSchema.parse(request.body ?? {});
    const consumed = consumeRecoveryCode(deps.db, body.code, now(deps));
    if (consumed === undefined) {
      countAuthFailure(deps, "recovery");
      throw unauthorized("recovery code is invalid or already used");
    }
    const user = getUserById(deps.db, consumed.userId);
    if (user === undefined) {
      throw notFound("user no longer exists");
    }
    const at = now(deps);
    const passwordHash = await hasherFor(deps).hash(body.newPassword);
    setPasswordHash(deps.db, user.id, passwordHash, at);
    revokeUserSessions(deps.db, user.id, at);
    const recoveryCodes = generateRecoveryCodes(deps.db, { userId: user.id, now: at });
    const response: SetupResponse = {
      ...authenticate(deps, user, request, reply),
      recoveryCodes,
    };
    reply.status(200).send(response);
  });

  app.post("/v1/auth/recovery-codes", async (request, reply) => {
    const principal = requireSessionPrincipal(request);
    requireCsrf(request, principal);
    const codes = generateRecoveryCodes(deps.db, { userId: principal.userId, now: now(deps) });
    reply.send({ codes } satisfies RecoveryCodesResponse);
  });

  app.get("/v1/auth/sessions", async (request, reply) => {
    const principal = requireSessionPrincipal(request);
    const sessions = listSessions(deps.db, principal.userId, now(deps));
    reply.send({
      sessions: sessions.map((session) => toSession(session, principal.session.id)),
    } satisfies ListSessionsResponse);
  });

  app.delete<{ Params: { id: string } }>("/v1/auth/sessions/:id", async (request, reply) => {
    const principal = requireSessionPrincipal(request);
    requireCsrf(request, principal);
    revokeSession(deps.db, request.params.id, now(deps));
    reply.status(204).send();
  });

  app.get("/v1/auth/tokens", async (request, reply) => {
    requireSessionPrincipal(request);
    reply.send({
      tokens: listApiTokens(deps.db).map((token) => ({
        id: token.id,
        name: token.name,
        scopes: token.scopes,
        createdAt: toIsoTimestamp(token.createdAt) ?? "",
        expiresAt: toIsoTimestamp(token.expiresAt),
        revokedAt: toIsoTimestamp(token.revokedAt),
        lastUsedAt: toIsoTimestamp(token.lastUsedAt),
      })),
    } satisfies ListApiTokensResponse);
  });

  app.post("/v1/auth/tokens", async (request, reply) => {
    const principal = requireSessionPrincipal(request);
    requireCsrf(request, principal);
    const body = createApiTokenRequestSchema.parse(request.body ?? {});
    const at = now(deps);
    const created = createApiToken(deps.db, {
      userId: principal.userId,
      name: body.name,
      scopes: body.scopes,
      now: at,
      expiresAt:
        body.expiresAt === undefined || body.expiresAt === null ? null : Date.parse(body.expiresAt),
    });
    const response: CreateApiTokenResponse = {
      token: {
        id: created.token.id,
        name: created.token.name,
        scopes: created.token.scopes,
        createdAt: toIsoTimestamp(created.token.createdAt) ?? "",
        expiresAt: toIsoTimestamp(created.token.expiresAt),
        revokedAt: toIsoTimestamp(created.token.revokedAt),
        lastUsedAt: toIsoTimestamp(created.token.lastUsedAt),
      },
      secret: created.secret,
    };
    reply.status(201).send(response);
  });

  app.delete<{ Params: { id: string } }>("/v1/auth/tokens/:id", async (request, reply) => {
    const principal = requireSessionPrincipal(request);
    requireCsrf(request, principal);
    revokeApiToken(deps.db, request.params.id, now(deps));
    reply.status(204).send();
  });

  app.get("/v1/auth/passkeys", async (request, reply) => {
    const principal = requireSessionPrincipal(request);
    reply.send({
      passkeys: listPasskeys(deps.db, principal.userId).map(toPasskey),
    } satisfies ListPasskeysResponse);
  });

  app.post("/v1/auth/passkeys/registration/options", async (request, reply) => {
    const principal = requireSessionPrincipal(request);
    requireCsrf(request, principal);
    const user = getUserById(deps.db, principal.userId);
    if (user === undefined) {
      throw unauthorized();
    }
    const options = await beginPasskeyRegistration(
      deps.db,
      passkeyConfig(deps),
      { id: user.id, username: user.username },
      now(deps),
    );
    reply.send({ options });
  });

  app.post("/v1/auth/passkeys/registration/verify", async (request, reply) => {
    const principal = requireSessionPrincipal(request);
    requireCsrf(request, principal);
    const body = request.body as { response?: unknown; name?: string } | undefined;
    if (body === undefined || body.response === undefined) {
      throw notFound("registration response is required");
    }
    const passkey = await finishPasskeyRegistration(
      deps.db,
      passkeyConfig(deps),
      { id: principal.userId },
      body.response as RegistrationResponseJSON,
      { ...(body.name !== undefined ? { name: body.name } : {}), now: now(deps) },
    );
    if (passkey === undefined) {
      throw forbidden("passkey registration could not be verified");
    }
    reply.send({ verified: true, credential: toPasskey(passkey) });
  });

  app.post("/v1/auth/passkeys/authentication/options", async (request, reply) => {
    enforceAuthRateLimit(request);
    const user = getSoleUser(deps.db);
    if (user === undefined) {
      throw notFound("no user is configured");
    }
    const options = await beginPasskeyAuthentication(
      deps.db,
      passkeyConfig(deps),
      { id: user.id },
      now(deps),
    );
    reply.send({ options });
  });

  app.post("/v1/auth/passkeys/authentication/verify", async (request, reply) => {
    enforceAuthRateLimit(request);
    const body = request.body as { response?: unknown } | undefined;
    if (body === undefined || body.response === undefined) {
      throw unauthorized("authentication response is required");
    }
    const result = await finishPasskeyAuthentication(
      deps.db,
      passkeyConfig(deps),
      body.response as AuthenticationResponseJSON,
      now(deps),
    );
    if (result === undefined) {
      countAuthFailure(deps, "passkey");
      throw unauthorized("passkey authentication failed");
    }
    const user = getUserById(deps.db, result.userId);
    if (user === undefined) {
      throw unauthorized();
    }
    reply.status(200).send(authenticate(deps, user, request, reply));
  });

  app.delete<{ Params: { id: string } }>("/v1/auth/passkeys/:id", async (request, reply) => {
    const principal = requireSessionPrincipal(request);
    requireCsrf(request, principal);
    deletePasskey(deps.db, request.params.id, principal.userId);
    reply.status(204).send();
  });

  app.get("/v1/auth/mail-credential", async (request, reply) => {
    const principal = requireSessionPrincipal(request);
    const credential = getActiveMailCredential(deps.db, principal.userId);
    const response: MailCredentialResponse = {
      credential: credential === undefined ? null : toMailCredential(credential),
    };
    reply.send(response);
  });

  app.post("/v1/auth/mail-credential", async (request, reply) => {
    const principal = requireSessionPrincipal(request);
    requireCsrf(request, principal);
    const body = rotateMailCredentialRequestSchema.parse(request.body ?? {});
    const at = now(deps);
    const passwordHash = await hasherFor(deps).hash(body.password);
    const credential = rotateMailCredential(deps.db, {
      userId: principal.userId,
      passwordHash,
      now: at,
    });
    const response: MailCredentialResponse = { credential: toMailCredential(credential) };
    reply.status(201).send(response);
  });

  app.delete("/v1/auth/mail-credential", async (request, reply) => {
    const principal = requireSessionPrincipal(request);
    requireCsrf(request, principal);
    revokeMailCredential(deps.db, principal.userId, now(deps));
    reply.status(204).send();
  });
}
