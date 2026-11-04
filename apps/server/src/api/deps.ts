import type { SqliteDatabase } from "../db/database.js";
import type { MailStoreAdapter } from "../mailstore/adapter.js";
import type { QuarantineService } from "../quarantine/service.js";
import type { ReplyClient } from "../reply/client.js";
import type { PasswordHasher } from "../auth/password.js";
import type { PasskeyConfig } from "../auth/passkeys.js";
import type { AbuseLimits } from "../abuse/limits.js";
import type { AlertSink } from "../abuse/disk.js";
import type { SlidingWindowRateLimiter } from "../abuse/rateLimit.js";
import type { MetricsRegistry } from "../metrics/registry.js";

/** Configuration for the management API. */
export interface ManagementApiConfig {
  /** The alias domain new aliases are generated in. */
  domain: string;
  /** The primary address, offered as an alternative reply identity. */
  primaryAddress?: string | null;
  /** Session lifetime in milliseconds. */
  sessionTtlMs?: number;
  /** Whether the session cookie sets `Secure`. Defaults to true. */
  secureCookies?: boolean;
  /** The session cookie `SameSite` policy. Defaults to `lax`. */
  sameSite?: "lax" | "strict" | "none";
  /** Abuse controls. Defaults to {@link defaultAbuseLimits}. */
  limits?: AbuseLimits;
  /** WebAuthn relying-party configuration. Passkeys are disabled when absent. */
  passkeys?: PasskeyConfig;
  /**
   * A bearer token that guards `/metrics`. When absent the endpoint is open,
   * which is only appropriate when it is bound to a private interface.
   */
  metricsToken?: string;
}

/** Dependencies shared by every management API route. */
export interface ApiDeps {
  db: SqliteDatabase;
  mailStore: MailStoreAdapter;
  quarantine: QuarantineService;
  replyClient: ReplyClient;
  config: ManagementApiConfig;
  /** The time source. Defaults to `Date.now`. */
  now?: () => number;
  /** The password hasher. Defaults to Argon2id. */
  passwordHasher?: PasswordHasher;
  /** The rate limiter. Defaults to a fresh in-process limiter. */
  rateLimiter?: SlidingWindowRateLimiter;
  /** Where operational alerts go. */
  alerts?: AlertSink;
  /** Where metrics are recorded. The `/metrics` route is only served when set. */
  metrics?: MetricsRegistry;
  /** Refreshes the pull-based gauges immediately before `/metrics` renders. */
  collectMetrics?: () => Promise<void>;
}
