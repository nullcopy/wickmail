import type { FastifyInstance } from "fastify";
import { buildApi } from "./api/app.js";
import type { AlertSink } from "./abuse/disk.js";
import { defaultAbuseLimits, toQuarantineQuota, type AbuseLimits } from "./abuse/limits.js";
import { SlidingWindowRateLimiter } from "./abuse/rateLimit.js";
import type { PasskeyConfig } from "./auth/passkeys.js";
import type { PasswordHasher } from "./auth/password.js";
import { openDatabase, type SqliteDatabase } from "./db/database.js";
import { migrate } from "./db/migrations.js";
import { migrations } from "./db/migrations/index.js";
import { FileMailStore } from "./mailstore/filesystem.js";
import { defaultQuarantineRetentionPolicy } from "./quarantine/types.js";
import { QuarantineService } from "./quarantine/service.js";
import { ReplyClient } from "./reply/client.js";
import { MemoryOutboundQueue } from "./reply/queue.js";

/** Configuration for a Wickmail server process. */
export interface WickmailServerConfig {
  /** The SQLite database file, or `:memory:`. */
  databasePath: string;
  /** The alias domain new aliases are generated in. */
  domain: string;
  /** The primary address, offered as an alternative reply identity. */
  primaryAddress?: string | null;
  /** The mail-store root directory. */
  mailStoreDirectory: string;
  /** Session lifetime in milliseconds. */
  sessionTtlMs?: number;
  /** Whether the session cookie sets `Secure`. Defaults to true. */
  secureCookies?: boolean;
  /** The session cookie `SameSite` policy. */
  sameSite?: "lax" | "strict" | "none";
  /** Abuse controls. Defaults to {@link defaultAbuseLimits}. */
  limits?: AbuseLimits;
  /** WebAuthn relying-party configuration. Passkeys are disabled when absent. */
  passkeys?: PasskeyConfig;
  /** The password hasher. Defaults to Argon2id. */
  passwordHasher?: PasswordHasher;
  /** Where operational alerts go. */
  alerts?: AlertSink;
  /** Enable Fastify request logging. */
  logger?: boolean;
  /** The time source. Defaults to `Date.now`. */
  now?: () => number;
}

/** A composed Wickmail server: database, mail store, quarantine, reply, and API. */
export interface WickmailServer {
  app: FastifyInstance;
  db: SqliteDatabase;
  mailStore: FileMailStore;
  quarantine: QuarantineService;
  replyClient: ReplyClient;
  /** Close the HTTP server and the database. */
  close(): Promise<void>;
}

/**
 * Compose the management API on top of the real SQLite-backed M1–M4 logic.
 * The caller owns the lifecycle and closes the returned server.
 */
export async function createWickmailServer(config: WickmailServerConfig): Promise<WickmailServer> {
  const db = openDatabase({ path: config.databasePath });
  migrate(db, migrations);

  const mailStore = new FileMailStore({ directory: config.mailStoreDirectory });
  const limits = config.limits ?? defaultAbuseLimits();
  const quarantine = new QuarantineService({
    db,
    store: mailStore,
    ...(config.now !== undefined ? { now: config.now } : {}),
    policy: { ...defaultQuarantineRetentionPolicy(), quota: toQuarantineQuota(limits) },
  });

  const queue = new MemoryOutboundQueue();
  const rateLimiter = new SlidingWindowRateLimiter(
    config.now !== undefined ? { now: config.now } : {},
  );
  const replyClient = new ReplyClient({
    db,
    mailStore,
    queue,
    primaryAddress: config.primaryAddress ?? null,
    ...(config.now !== undefined ? { now: config.now } : {}),
    rateLimiter,
    outboundPerMinute: limits.rateLimits.outboundPerMinute,
  });

  const app = await buildApi({
    db,
    mailStore,
    quarantine,
    replyClient,
    config: {
      domain: config.domain,
      primaryAddress: config.primaryAddress ?? null,
      ...(config.sessionTtlMs !== undefined ? { sessionTtlMs: config.sessionTtlMs } : {}),
      ...(config.secureCookies !== undefined ? { secureCookies: config.secureCookies } : {}),
      ...(config.sameSite !== undefined ? { sameSite: config.sameSite } : {}),
      limits,
      ...(config.passkeys !== undefined ? { passkeys: config.passkeys } : {}),
    },
    ...(config.now !== undefined ? { now: config.now } : {}),
    ...(config.passwordHasher !== undefined ? { passwordHasher: config.passwordHasher } : {}),
    ...(config.alerts !== undefined ? { alerts: config.alerts } : {}),
    ...(config.logger !== undefined ? { logger: config.logger } : {}),
  });

  return {
    app,
    db,
    mailStore,
    quarantine,
    replyClient,
    async close(): Promise<void> {
      quarantine.stop();
      await app.close();
      db.close();
    },
  };
}

/** Options for {@link startWickmailServer}. */
export interface StartServerOptions extends WickmailServerConfig {
  /** The interface to bind. Defaults to `127.0.0.1`. */
  host?: string;
  /** The TCP port to bind. Defaults to 8080. */
  port?: number;
}

/** Compose and start the management API. */
export async function startWickmailServer(
  options: StartServerOptions,
): Promise<WickmailServer & { address: string }> {
  const server = await createWickmailServer(options);
  const address = await server.app.listen({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 8080,
  });
  return { ...server, address };
}
