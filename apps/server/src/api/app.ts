import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAliasRoutes } from "./aliases.js";
import { registerAuthRoutes } from "./auth.js";
import { resolvePrincipal } from "./context.js";
import type { ApiDeps } from "./deps.js";
import { registerErrorHandling } from "./errors.js";
import { registerMessageRoutes } from "./messages.js";
import { registerQuarantineRoutes } from "./quarantine.js";

/** Options for {@link buildApi}. */
export interface BuildApiOptions extends ApiDeps {
  /** Enable Fastify's request logging. Defaults to false. */
  logger?: boolean;
}

/**
 * Build the management API.
 *
 * The app resolves the request principal from a bearer token or the session
 * cookie before every route, installs the shared error handler, and registers
 * the alias, quarantine, message, and authentication routes. It is not
 * listening: callers use `inject` in tests or `listen` in production.
 */
export async function buildApi(options: BuildApiOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 });
  await app.register(cookie);

  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (request) => {
    request.principal = resolvePrincipal(options.db, request, (options.now ?? Date.now)()) ?? null;
  });

  registerErrorHandling(app);
  registerAuthRoutes(app, options);
  registerAliasRoutes(app, options);
  registerQuarantineRoutes(app, options);
  registerMessageRoutes(app, options);

  return app;
}
