/**
 * Errors raised by the management API client.
 *
 * The server returns a JSON error envelope with a stable `code`. Network
 * failures have no status and use the local `network` code.
 */

/** A failed management API request. */
export class ApiError extends Error {
  /** HTTP status, or 0 when the request never reached the server. */
  readonly status: number;
  /** Stable machine-readable error code, or a local code. */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /** The server could not be reached. */
  get isOffline(): boolean {
    return this.status === 0;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/** Returns true for an {@link ApiError}. */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** A short, user-facing message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isOffline) {
      return "The server could not be reached. Check your connection and try again.";
    }
    if (error.isForbidden) {
      return error.message || "This action is not permitted for the current credentials.";
    }
    return error.message || "The request failed.";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong.";
}

/** A heading for a failed request, distinguishing permission and offline states. */
export function errorTitle(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isOffline) return "You are offline";
    if (error.isForbidden) return "Not permitted";
    if (error.isUnauthorized) return "Session expired";
  }
  return "Something went wrong";
}
