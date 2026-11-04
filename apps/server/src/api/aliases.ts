import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createAliasRequestSchema,
  enableAliasRequestSchema,
  extendAliasRequestSchema,
  renewAliasRequestSchema,
  updateAliasRequestSchema,
  type AliasResponse,
  type ListAliasEventsResponse,
  type ListAliasesResponse,
} from "wickmail-core";
import { queryAliases } from "../alias/query.js";
import {
  AliasOwnershipError,
  listOwnedAliases,
  requireOwnedAlias,
  toAlias,
  toAliasEvent,
} from "../alias/ownership.js";
import {
  AliasNotFoundError,
  createAliasWithGeneratedAddress,
  PolicyVersionConflictError,
  updateAlias,
  type AliasChanges,
  type AliasRow,
} from "../alias/repository.js";
import { recordAuditEvent, listAuditEvents } from "../audit/events.js";
import { applyManualAction, type ManualAction } from "../lease/actions.js";
import { fromIsoTimestamp, secondsToMs } from "../time.js";
import { idempotencyKey, requireCsrf, requireScope } from "./context.js";
import type { ApiDeps } from "./deps.js";
import { conflict, forbidden, notFound } from "./errors.js";
import { runIdempotent } from "./idempotency.js";
import { parseListAliasesQuery } from "./query.js";

/** The default lease when a creation request omits one: seven days. */
export const DEFAULT_LEASE_SECONDS = 7 * 24 * 60 * 60;

function now(deps: ApiDeps): number {
  return (deps.now ?? Date.now)();
}

function resolveAlias(deps: ApiDeps, userId: string, aliasId: string): AliasRow {
  try {
    return requireOwnedAlias(deps.db, aliasId, userId);
  } catch (error) {
    if (error instanceof AliasNotFoundError) {
      throw notFound(`alias not found: ${aliasId}`);
    }
    if (error instanceof AliasOwnershipError) {
      throw forbidden("alias is not owned by the requesting user");
    }
    throw error;
  }
}

function expiresAtForRequest(
  lease: ReturnType<typeof createAliasRequestSchema.parse>["lease"],
  at: number,
): { expiresAt: number | null; leaseDurationSeconds: number } {
  if (lease === undefined) {
    const leaseDurationSeconds = DEFAULT_LEASE_SECONDS;
    return { expiresAt: at + secondsToMs(leaseDurationSeconds), leaseDurationSeconds };
  }
  switch (lease.type) {
    case "duration":
      return {
        expiresAt: at + secondsToMs(lease.durationSeconds),
        leaseDurationSeconds: lease.durationSeconds,
      };
    case "absolute":
      return {
        expiresAt: fromIsoTimestamp(lease.expiresAt),
        leaseDurationSeconds: DEFAULT_LEASE_SECONDS,
      };
    case "none":
      return { expiresAt: null, leaseDurationSeconds: DEFAULT_LEASE_SECONDS };
  }
}

function applyAction(
  deps: ApiDeps,
  userId: string,
  aliasId: string,
  action: ManualAction,
  eventType:
    | "renewed_manually"
    | "extended_manually"
    | "expiry_set"
    | "expiry_removed"
    | "disabled"
    | "enabled",
): AliasRow {
  const at = now(deps);
  const alias = resolveAlias(deps, userId, aliasId);
  const outcome = applyManualAction(alias, action, at);
  if (!outcome.applied) {
    throw conflict(outcome.reason ?? "action is not allowed in the current state");
  }

  const changes: AliasChanges = {};
  if (outcome.fields.expiresAt !== alias.expiresAt) {
    changes.expiresAt = outcome.fields.expiresAt;
  }
  if (outcome.fields.disabledAt !== alias.disabledAt) {
    changes.disabledAt = outcome.fields.disabledAt;
  }
  if (outcome.updatesUserActivity) {
    changes.lastUserActivityAt = at;
  }

  const updated = updateAlias(deps.db, alias.id, changes);
  recordAuditEvent(deps.db, {
    aliasId: alias.id,
    type: eventType,
    occurredAt: at,
    detail: { expiresAt: updated.expiresAt, disabledAt: updated.disabledAt },
  });
  return updated;
}

/** Run a lease action idempotently and build the single-alias response. */
async function idempotentAliasAction(
  deps: ApiDeps,
  request: FastifyRequest,
  scope: string,
  compute: () => AliasRow,
): Promise<{ status: number; body: AliasResponse }> {
  return runIdempotent(
    deps.db,
    { key: idempotencyKey(request), scope, now: now(deps) },
    async () => {
      const alias = compute();
      return { status: 200, body: { alias: toAlias(alias, now(deps)) } satisfies AliasResponse };
    },
  );
}

/** Register the `/v1/aliases` routes. */
export function registerAliasRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post("/v1/aliases", async (request, reply) => {
    const principal = requireScope(request, "aliases:write");
    requireCsrf(request, principal);
    const body = createAliasRequestSchema.parse(request.body ?? {});
    const at = now(deps);

    const outcome = await runIdempotent(
      deps.db,
      { key: idempotencyKey(request), scope: "aliases.create", now: at },
      async () => {
        const { expiresAt, leaseDurationSeconds } = expiresAtForRequest(body.lease, at);
        const alias = createAliasWithGeneratedAddress(deps.db, {
          domain: deps.config.domain,
          label: body.label,
          purpose: body.purpose ?? null,
          createdAt: at,
          expiresAt,
          leaseDurationSeconds,
          renewOnOutbound: body.renewOnOutbound ?? true,
          ownerId: principal.userId,
        });
        recordAuditEvent(deps.db, {
          aliasId: alias.id,
          type: "created",
          occurredAt: at,
          detail: { leaseDurationSeconds, expiresAt },
        });
        const response: AliasResponse = { alias: toAlias(alias, at) };
        return { status: 201, body: response };
      },
    );

    reply.status(outcome.status).send(outcome.body);
  });

  app.get("/v1/aliases", async (request, reply) => {
    const principal = requireScope(request, "aliases:read");
    const query = parseListAliasesQuery(request.query);
    const at = now(deps);
    const page = queryAliases(listOwnedAliases(deps.db, principal.userId), query, at);
    const response: ListAliasesResponse = {
      aliases: page.rows.map((row) => toAlias(row, at)),
      nextCursor: page.nextCursor,
    };
    reply.send(response);
  });

  app.get<{ Params: { id: string } }>("/v1/aliases/:id", async (request, reply) => {
    const principal = requireScope(request, "aliases:read");
    const alias = resolveAlias(deps, principal.userId, request.params.id);
    const response: AliasResponse = { alias: toAlias(alias, now(deps)) };
    reply.send(response);
  });

  app.patch<{ Params: { id: string } }>("/v1/aliases/:id", async (request, reply) => {
    const principal = requireScope(request, "aliases:write");
    requireCsrf(request, principal);
    const body = updateAliasRequestSchema.parse(request.body ?? {});
    const alias = resolveAlias(deps, principal.userId, request.params.id);

    const changes: AliasChanges = {};
    if (body.label !== undefined) changes.label = body.label;
    if (body.purpose !== undefined) changes.purpose = body.purpose;
    if (body.renewOnOutbound !== undefined) changes.renewOnOutbound = body.renewOnOutbound;

    let updated: AliasRow;
    try {
      updated = updateAlias(deps.db, alias.id, changes, {
        expectedPolicyVersion: body.policyVersion,
      });
    } catch (error) {
      if (error instanceof PolicyVersionConflictError) {
        throw conflict("alias was modified by another request", {
          expected: error.expected,
          actual: error.actual,
        });
      }
      throw error;
    }

    const response: AliasResponse = { alias: toAlias(updated, now(deps)) };
    reply.send(response);
  });

  app.post<{ Params: { id: string } }>("/v1/aliases/:id/renew", async (request, reply) => {
    const principal = requireScope(request, "aliases:write");
    requireCsrf(request, principal);
    const body = renewAliasRequestSchema.parse(request.body ?? {});
    const outcome = await idempotentAliasAction(
      deps,
      request,
      `aliases.renew:${request.params.id}`,
      () =>
        applyAction(
          deps,
          principal.userId,
          request.params.id,
          body.durationSeconds === undefined
            ? { type: "renew" }
            : { type: "renew", durationSeconds: body.durationSeconds },
          "renewed_manually",
        ),
    );
    reply.status(outcome.status).send(outcome.body);
  });

  app.post<{ Params: { id: string } }>("/v1/aliases/:id/extend", async (request, reply) => {
    const principal = requireScope(request, "aliases:write");
    requireCsrf(request, principal);
    const body = extendAliasRequestSchema.parse(request.body ?? {});
    const outcome = await idempotentAliasAction(
      deps,
      request,
      `aliases.extend:${request.params.id}`,
      () =>
        applyAction(
          deps,
          principal.userId,
          request.params.id,
          body.durationSeconds === undefined
            ? { type: "extend" }
            : { type: "extend", durationSeconds: body.durationSeconds },
          "extended_manually",
        ),
    );
    reply.status(outcome.status).send(outcome.body);
  });

  app.post<{ Params: { id: string } }>("/v1/aliases/:id/disable", async (request, reply) => {
    const principal = requireScope(request, "aliases:write");
    requireCsrf(request, principal);
    const outcome = await idempotentAliasAction(
      deps,
      request,
      `aliases.disable:${request.params.id}`,
      () => applyAction(deps, principal.userId, request.params.id, { type: "disable" }, "disabled"),
    );
    reply.status(outcome.status).send(outcome.body);
  });

  app.post<{ Params: { id: string } }>("/v1/aliases/:id/enable", async (request, reply) => {
    const principal = requireScope(request, "aliases:write");
    requireCsrf(request, principal);
    const body = enableAliasRequestSchema.parse(request.body ?? {});
    let expiresAt: number | undefined;
    if (body.expiresAt !== undefined) {
      expiresAt = fromIsoTimestamp(body.expiresAt);
    }
    const outcome = await idempotentAliasAction(
      deps,
      request,
      `aliases.enable:${request.params.id}`,
      () =>
        applyAction(
          deps,
          principal.userId,
          request.params.id,
          expiresAt === undefined ? { type: "enable" } : { type: "enable", expiresAt },
          "enabled",
        ),
    );
    reply.status(outcome.status).send(outcome.body);
  });

  app.get<{ Params: { id: string } }>("/v1/aliases/:id/events", async (request, reply) => {
    const principal = requireScope(request, "aliases:read");
    const alias = resolveAlias(deps, principal.userId, request.params.id);
    const response: ListAliasEventsResponse = {
      events: listAuditEvents(deps.db, alias.id).map(toAliasEvent),
    };
    reply.send(response);
  });
}
