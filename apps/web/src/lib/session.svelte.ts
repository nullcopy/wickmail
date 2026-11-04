/**
 * Authentication and preference state for the app shell.
 *
 * The client holds the session cookie or an in-memory bearer token. Tokens are
 * never written to browser storage. Preferences are non-sensitive UI defaults
 * and are the only persisted values.
 */

import { ApiClient } from "./api";
import { isApiError } from "./errors";
import { loadPreferences, savePreferences, type Preferences } from "./preferences";

/** How the app is authenticated. */
export type AuthState = "loading" | "anonymous" | "authenticated" | "offline";

class SessionStore {
  readonly client = new ApiClient();

  /** The current authentication state. */
  state = $state<AuthState>("loading");

  /** True when the session is a bearer token rather than a cookie. */
  tokenMode = $state(false);

  /** The error that put the app in the offline state. */
  offlineError = $state<unknown>(null);

  /** Non-sensitive UI preferences. */
  preferences = $state<Preferences>(loadPreferences());

  constructor() {
    this.client.onUnauthorized = () => {
      if (this.state === "authenticated") {
        this.reset();
      }
    };
  }

  /** Resolves the current session from the cookie, if any. */
  async initialize(): Promise<void> {
    this.state = "loading";
    this.offlineError = null;
    try {
      const response = await this.client.getSession();
      this.client.csrfToken = response.csrfToken;
      this.tokenMode = false;
      this.state = "authenticated";
    } catch (error) {
      if (isApiError(error) && error.isOffline) {
        this.offlineError = error;
        this.state = "offline";
      } else {
        this.state = "anonymous";
      }
    }
  }

  /** Starts a cookie session with the management password. */
  async login(password: string): Promise<void> {
    const response = await this.client.login(password);
    this.client.csrfToken = response.csrfToken;
    this.tokenMode = false;
    this.state = "authenticated";
  }

  /**
   * Authenticates with a bearer token for this session only.
   *
   * A valid token that lacks `aliases:read` still authenticates; the screens
   * that need more scope then surface permission errors.
   */
  async loginWithToken(token: string): Promise<void> {
    this.client.bearerToken = token;
    this.client.csrfToken = null;
    try {
      await this.client.listAliases({ limit: 1 });
      this.tokenMode = true;
      this.state = "authenticated";
    } catch (error) {
      if (isApiError(error) && error.isForbidden) {
        this.tokenMode = true;
        this.state = "authenticated";
        return;
      }
      this.client.bearerToken = null;
      throw error;
    }
  }

  /** Ends the session and clears in-memory credentials. */
  async logout(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      // Clearing local state is enough even if the server call fails.
    }
    this.reset();
  }

  /** Clears credentials and returns to the anonymous state. */
  reset(): void {
    this.client.bearerToken = null;
    this.client.csrfToken = null;
    this.tokenMode = false;
    this.state = "anonymous";
  }

  /** Persists and applies updated preferences. */
  updatePreferences(next: Preferences): void {
    this.preferences = next;
    savePreferences(next);
  }
}

export const session = new SessionStore();
