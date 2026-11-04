import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./deps.js";

/** The Prometheus text exposition content type. */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/**
 * Register `GET /metrics`.
 *
 * The route is only served when a metrics registry is configured. Pull-based
 * gauges (spool, disk, certificate, queue) are refreshed by `collectMetrics`
 * immediately before rendering, so a scrape observes current values. When a
 * `metricsToken` is configured the route requires it as a bearer token;
 * otherwise the endpoint is unauthenticated and must be bound to a private
 * interface or protected by the reverse proxy.
 */
export function registerMetricsRoute(app: FastifyInstance, deps: ApiDeps): void {
  const metrics = deps.metrics;
  if (metrics === undefined) {
    return;
  }

  app.get("/metrics", async (request, reply) => {
    const token = deps.config.metricsToken;
    if (token !== undefined && token.length > 0) {
      const authorization = request.headers.authorization;
      if (authorization !== `Bearer ${token}`) {
        reply.header("www-authenticate", "Bearer");
        reply.status(401).send("unauthorized\n");
        return;
      }
    }
    await deps.collectMetrics?.();
    reply.header("content-type", PROMETHEUS_CONTENT_TYPE);
    reply.send(metrics.render());
  });
}
