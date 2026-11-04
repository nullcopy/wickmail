import type { FastifyInstance } from "fastify";
import type { ApiError as ApiErrorBody } from "wickmail-core";
import { ZodError } from "zod";

/** A management API error carrying an HTTP status and a stable machine code. */
export class ApiError extends Error {
  override name = "ApiError";

  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** 401: no valid credentials. */
export function unauthorized(message = "authentication required"): ApiError {
  return new ApiError(401, "unauthorized", message);
}

/** 403: authenticated but not allowed. */
export function forbidden(message = "insufficient scope"): ApiError {
  return new ApiError(403, "forbidden", message);
}

/** 404: the resource does not exist or is not visible to the caller. */
export function notFound(message = "not found"): ApiError {
  return new ApiError(404, "not_found", message);
}

/** 409: the request conflicts with current state. */
export function conflict(message: string, details?: unknown): ApiError {
  return new ApiError(409, "conflict", message, details);
}

/** 400: the request is malformed. */
export function badRequest(message: string, details?: unknown): ApiError {
  return new ApiError(400, "bad_request", message, details);
}

/** 403: the CSRF token is missing or wrong. */
export function csrfFailure(): ApiError {
  return new ApiError(403, "csrf_failed", "CSRF token missing or invalid");
}

/** 429: a rate limit was exceeded. */
export function rateLimited(retryAfterMs: number): ApiError {
  return new ApiError(429, "rate_limited", "rate limit exceeded", { retryAfterMs });
}

/** 503: a dependency is temporarily unavailable. */
export function tempUnavailable(message: string): ApiError {
  return new ApiError(503, "temporarily_unavailable", message);
}

/** 501: the feature is not configured on this server. */
export function notImplemented(message: string): ApiError {
  return new ApiError(501, "not_implemented", message);
}

/** Build the wire body for an error. */
export function errorBody(error: ApiError): ApiErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  };
}

/** Install the shared error handler and not-found handler. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send(errorBody(notFound("no such endpoint")));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.statusCode === 429 && typeof error.details === "object" && error.details !== null) {
        const retryAfterMs = (error.details as { retryAfterMs?: number }).retryAfterMs;
        if (typeof retryAfterMs === "number") {
          reply.header("Retry-After", Math.ceil(retryAfterMs / 1000));
        }
      }
      reply.status(error.statusCode).send(errorBody(error));
      return;
    }
    if (error instanceof ZodError) {
      reply.status(400).send(errorBody(badRequest("request validation failed", error.issues)));
      return;
    }
    request.log.error(error);
    reply.status(500).send({
      error: { code: "internal_error", message: "internal server error" },
    } satisfies ApiErrorBody);
  });
}
