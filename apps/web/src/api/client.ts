import { createApiClient, type ApiClient } from "wickmail-core";

/**
 * The in-memory CSRF token. It is held in a module variable, never in browser
 * storage, and is refreshed from each session response.
 */
export const csrfTokenHolder: { token: string | null } = { token: null };

/** Build the same-origin management API client. */
export function createBrowserClient(): ApiClient {
  return createApiClient({ getCsrfToken: () => csrfTokenHolder.token });
}
