import "fastify";
import type { Principal } from "../auth/principal.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The authenticated principal, or null for an unauthenticated request. */
    principal: Principal | null;
  }
}
