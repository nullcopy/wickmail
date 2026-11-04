import type { FastifyInstance } from "fastify";
import {
  deleteQuarantineRequestSchema,
  recoverQuarantineRequestSchema,
  type DeleteQuarantineResponse,
  type ListQuarantineResponse,
  type QuarantineResponse,
  type QuarantineSort,
  type RecoverQuarantineResponse,
  type SortOrder,
} from "wickmail-core";
import { listOwnedAliases } from "../alias/ownership.js";
import { updateAlias, type AliasChanges } from "../alias/repository.js";
import { recordAuditEvent } from "../audit/events.js";
import { applyManualAction } from "../lease/actions.js";
import {
  getQuarantineEntry,
  requireQuarantineEntry,
  toQuarantinedMessage,
} from "../quarantine/repository.js";
import type { QuarantineEntry } from "../quarantine/types.js";
import { fromIsoTimestamp } from "../time.js";
import { idempotencyKey, requireCsrf, requireScope } from "./context.js";
import type { ApiDeps } from "./deps.js";
import { badRequest, conflict, notFound, tempUnavailable } from "./errors.js";
import { runIdempotent } from "./idempotency.js";
import { parseListQuarantineQuery } from "./query.js";

/** The default number of quarantined messages returned in one page. */
export const DEFAULT_QUARANTINE_PAGE_SIZE = 50;

function now(deps: ApiDeps): number {
  return (deps.now ?? Date.now)();
}

function ownedAliasIds(deps: ApiDeps, userId: string): Set<string> {
  return new Set(listOwnedAliases(deps.db, userId).map((alias) => alias.id));
}

/** Resolve a quarantined message, verifying it belongs to one of the user's aliases. */
function resolveQuarantine(deps: ApiDeps, userId: string, messageId: string): QuarantineEntry {
  const entry = getQuarantineEntry(deps.db, messageId);
  if (entry === undefined) {
    throw notFound(`quarantined message not found: ${messageId}`);
  }
  const owned = ownedAliasIds(deps, userId);
  if (!entry.aliasIds.some((aliasId) => owned.has(aliasId))) {
    throw notFound(`quarantined message not found: ${messageId}`);
  }
  return entry;
}

function sortValue(entry: QuarantineEntry, sort: QuarantineSort): number | null {
  return sort === "received" ? entry.receivedAt : entry.quarantineExpiresAt;
}

function compareValues(left: number | null, right: number | null, order: SortOrder): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return order === "asc" ? left - right : right - left;
}

function encodeCursor(entry: QuarantineEntry, sort: QuarantineSort): string {
  return Buffer.from(
    JSON.stringify({ v: sortValue(entry, sort), id: entry.messageId }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(raw: string): { v: number | null; id: string } | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      v?: unknown;
      id?: unknown;
    };
    if (typeof parsed.id === "string" && (parsed.v === null || typeof parsed.v === "number")) {
      return { v: parsed.v, id: parsed.id };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function matchesSearch(entry: QuarantineEntry, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    (entry.sender ?? "").toLowerCase().includes(needle) ||
    (entry.subject ?? "").toLowerCase().includes(needle)
  );
}

function applyLeaseAction(
  deps: ApiDeps,
  userId: string,
  aliasId: string,
  action: "renew" | "enable",
  options: { durationSeconds?: number; expiresAt?: number },
  at: number,
): void {
  const alias = listOwnedAliases(deps.db, userId).find((candidate) => candidate.id === aliasId);
  if (alias === undefined) {
    return;
  }
  const manual =
    action === "renew"
      ? options.durationSeconds === undefined
        ? ({ type: "renew" } as const)
        : ({ type: "renew", durationSeconds: options.durationSeconds } as const)
      : options.expiresAt === undefined
        ? ({ type: "enable" } as const)
        : ({ type: "enable", expiresAt: options.expiresAt } as const);
  const outcome = applyManualAction(alias, manual, at);
  if (!outcome.applied) {
    throw conflict(outcome.reason ?? "alias action is not allowed in the current state");
  }
  const changes: AliasChanges = {};
  if (outcome.fields.expiresAt !== alias.expiresAt) changes.expiresAt = outcome.fields.expiresAt;
  if (outcome.fields.disabledAt !== alias.disabledAt)
    changes.disabledAt = outcome.fields.disabledAt;
  if (outcome.updatesUserActivity) changes.lastUserActivityAt = at;
  updateAlias(deps.db, alias.id, changes);
  recordAuditEvent(deps.db, {
    aliasId: alias.id,
    type: action === "renew" ? "renewed_manually" : "enabled",
    occurredAt: at,
    detail: { expiresAt: outcome.fields.expiresAt, source: "quarantine_recovery" },
  });
}

/** Register the `/v1/quarantine` routes. */
export function registerQuarantineRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/v1/quarantine", async (request, reply) => {
    const principal = requireScope(request, "quarantine:read");
    const query = parseListQuarantineQuery(request.query);
    const sort = query.sort ?? "received";
    const order = query.order ?? "asc";
    const limit = query.limit ?? DEFAULT_QUARANTINE_PAGE_SIZE;
    const owned = ownedAliasIds(deps, principal.userId);

    const entries = deps.db
      .prepare(
        `SELECT message_id AS messageId FROM quarantine_messages ORDER BY received_at ASC, message_id ASC`,
      )
      .all() as Array<{ messageId: string }>;
    let resolved = entries
      .map((row) => getQuarantineEntry(deps.db, row.messageId))
      .filter((entry): entry is QuarantineEntry => entry !== undefined)
      .filter((entry) => entry.aliasIds.some((aliasId) => owned.has(aliasId)));

    if (query.status !== undefined) {
      resolved = resolved.filter((entry) => entry.status === query.status);
    }
    if (query.aliasId !== undefined) {
      resolved = resolved.filter((entry) => entry.aliasIds.includes(query.aliasId!));
    }
    if (query.search !== undefined) {
      resolved = resolved.filter((entry) => matchesSearch(entry, query.search!));
    }

    resolved.sort((left, right) => {
      const primary = compareValues(sortValue(left, sort), sortValue(right, sort), order);
      if (primary !== 0) return primary;
      return left.messageId.localeCompare(right.messageId);
    });

    let start = 0;
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor);
      if (cursor === undefined) {
        throw badRequest("invalid cursor");
      }
      start = resolved.findIndex((entry) => {
        const primary = compareValues(sortValue(entry, sort), cursor.v, order);
        if (primary !== 0) return primary > 0;
        return entry.messageId.localeCompare(cursor.id) > 0;
      });
      if (start === -1) {
        start = resolved.length;
      }
    }

    const page = resolved.slice(start, start + limit);
    const hasMore = resolved.length > start + limit;
    const response: ListQuarantineResponse = {
      messages: page.map(toQuarantinedMessage),
      nextCursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!, sort) : null,
    };
    reply.send(response);
  });

  app.get<{ Params: { id: string } }>("/v1/quarantine/:id", async (request, reply) => {
    const principal = requireScope(request, "quarantine:read");
    const entry = resolveQuarantine(deps, principal.userId, request.params.id);
    const response: QuarantineResponse = { message: toQuarantinedMessage(entry) };
    reply.send(response);
  });

  app.post<{ Params: { id: string } }>("/v1/quarantine/:id/recover", async (request, reply) => {
    const principal = requireScope(request, "quarantine:write");
    requireCsrf(request, principal);
    const body = recoverQuarantineRequestSchema.parse(request.body ?? {});
    if (body.renew === true && body.enable === true) {
      throw badRequest("renew and enable are mutually exclusive");
    }
    const entry = resolveQuarantine(deps, principal.userId, request.params.id);
    const at = now(deps);
    const key = idempotencyKey(request);

    const outcome = await runIdempotent(
      deps.db,
      { key, scope: `quarantine.recover:${entry.messageId}`, now: at },
      async () => {
        const result = await deps.quarantine.recover(
          entry.messageId,
          key !== undefined ? { idempotencyKey: key } : {},
        );
        if (result.status === "not_found") {
          throw notFound(`quarantined message not found: ${entry.messageId}`);
        }
        if (result.status === "blocked") {
          throw conflict(result.reason);
        }
        if (result.status === "incomplete") {
          throw tempUnavailable(result.reason);
        }

        if (body.renew === true || body.enable === true) {
          const expiresAt =
            body.expiresAt === undefined ? undefined : fromIsoTimestamp(body.expiresAt);
          for (const aliasId of entry.aliasIds) {
            applyLeaseAction(
              deps,
              principal.userId,
              aliasId,
              body.renew === true ? "renew" : "enable",
              {
                ...(body.durationSeconds !== undefined
                  ? { durationSeconds: body.durationSeconds }
                  : {}),
                ...(expiresAt !== undefined ? { expiresAt } : {}),
              },
              at,
            );
          }
        }

        const auditAliasId = entry.aliasIds[0];
        if (auditAliasId !== undefined) {
          recordAuditEvent(deps.db, {
            aliasId: auditAliasId,
            type: "recovered",
            occurredAt: at,
            detail: { messageId: entry.messageId },
          });
        }

        const response: RecoverQuarantineResponse = {
          status: result.status === "already_recovered" ? "already_recovered" : "recovered",
          message: toQuarantinedMessage(requireQuarantineEntry(deps.db, entry.messageId)),
        };
        return { status: 200, body: response };
      },
    );

    reply.status(outcome.status).send(outcome.body);
  });

  app.post<{ Params: { id: string } }>("/v1/quarantine/:id/delete", async (request, reply) => {
    const principal = requireScope(request, "quarantine:write");
    requireCsrf(request, principal);
    const body = deleteQuarantineRequestSchema.parse(request.body ?? {});
    const entry = resolveQuarantine(deps, principal.userId, request.params.id);
    const at = now(deps);

    const outcome = await runIdempotent(
      deps.db,
      { key: idempotencyKey(request), scope: `quarantine.delete:${entry.messageId}`, now: at },
      async () => {
        const result = await deps.quarantine.delete(entry.messageId, {
          reason: body.reason ?? "user_requested",
        });
        if (result.status === "not_found") {
          throw notFound(`quarantined message not found: ${entry.messageId}`);
        }
        if (result.status === "blocked") {
          throw conflict(result.reason);
        }
        const response: DeleteQuarantineResponse = {
          status: result.status === "already_deleted" ? "already_deleted" : "deleted",
          messageId: entry.messageId,
        };
        return { status: 200, body: response };
      },
    );

    reply.status(outcome.status).send(outcome.body);
  });
}
