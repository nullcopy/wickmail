import type { FastifyInstance } from "fastify";
import { replyRequestSchema, type ReplyContext, type ReplyResult } from "wickmail-core";
import { listOwnedAliases } from "../alias/ownership.js";
import type { ApiDeps } from "./deps.js";
import { idempotencyKey, requireCsrf, requireScope } from "./context.js";
import { conflict, notFound, tempUnavailable } from "./errors.js";
import { runIdempotent } from "./idempotency.js";

function now(deps: ApiDeps): number {
  return (deps.now ?? Date.now)();
}

/** Verify the message's provenance includes an alias owned by the user. */
function assertVisible(deps: ApiDeps, userId: string, context: ReplyContext): void {
  if (context.provenance.aliasIds.length === 0) {
    return;
  }
  const owned = new Set(listOwnedAliases(deps.db, userId).map((alias) => alias.id));
  if (!context.provenance.aliasIds.some((aliasId) => owned.has(aliasId))) {
    throw notFound(`no reply context for message: ${context.messageId}`);
  }
}

/** Register the `/v1/messages` reply routes. */
export function registerMessageRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get<{ Params: { id: string } }>("/v1/messages/:id/reply-context", async (request, reply) => {
    const principal = requireScope(request, "messages:read");
    const context = await deps.replyClient.fetchReplyContext(request.params.id);
    if (context === undefined) {
      throw notFound(`no reply context for message: ${request.params.id}`);
    }
    assertVisible(deps, principal.userId, context);
    const response: ReplyContext = context;
    reply.send(response);
  });

  app.post<{ Params: { id: string } }>("/v1/messages/:id/reply", async (request, reply) => {
    const principal = requireScope(request, "messages:reply");
    requireCsrf(request, principal);
    const body = replyRequestSchema.parse(request.body ?? {});
    const context = await deps.replyClient.fetchReplyContext(request.params.id);
    if (context === undefined) {
      throw notFound(`no reply context for message: ${request.params.id}`);
    }
    assertVisible(deps, principal.userId, context);
    const at = now(deps);

    const outcome = await runIdempotent(
      deps.db,
      { key: idempotencyKey(request), scope: `messages.reply:${request.params.id}`, now: at },
      async () => {
        const result = await deps.replyClient.submitReply(request.params.id, body);
        if (result.status === "rejected") {
          throw conflict(result.reason);
        }
        if (result.status === "tempfail") {
          throw tempUnavailable(result.reason);
        }
        const response: ReplyResult = {
          messageId: result.messageId,
          identity: result.identity,
          renewed: result.renewed,
          expiresAt: result.expiresAt === null ? null : new Date(result.expiresAt).toISOString(),
        };
        return { status: 200, body: response };
      },
    );

    reply.status(outcome.status).send(outcome.body);
  });
}
