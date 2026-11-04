import { ApiClientError } from "wickmail-core";

/** A user-facing error state. */
export type ErrorKind = "offline" | "permission" | "not_found" | "conflict" | "unknown";

/** A classified error with a message safe to show. */
export interface DescribedError {
  kind: ErrorKind;
  message: string;
}

/** Classify an error for presentation. */
export function describeError(error: unknown): DescribedError {
  if (error instanceof ApiClientError) {
    if (error.isNetworkError) {
      return {
        kind: "offline",
        message: "The server could not be reached. Check your connection and try again.",
      };
    }
    switch (error.status) {
      case 401:
        return { kind: "permission", message: "Your session has expired. Sign in again." };
      case 403:
        return { kind: "permission", message: error.message || "You do not have permission." };
      case 404:
        return { kind: "not_found", message: error.message || "The item no longer exists." };
      case 409:
        return { kind: "conflict", message: error.message || "The item changed on the server." };
      default:
        return { kind: "unknown", message: error.message || "Something went wrong." };
    }
  }
  return {
    kind: "unknown",
    message: error instanceof Error ? error.message : "Something went wrong.",
  };
}
