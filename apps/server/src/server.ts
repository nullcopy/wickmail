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
import { MetricsAlertSink } from "./metrics/alerts.js";
import { collectOperationalMetrics, collectQuarantineMetrics } from "./metrics/collect.js";
import { METRIC } from "./metrics/names.js";
import type { PostfixQueueProbeOptions } from "./metrics/postfix.js";
import { MetricsRegistry } from "./metrics/registry.js";
import type { ReconciliationReport } from "./quarantine/reconciliation.js";
import type { RetentionReport } from "./quarantine/retention.js";
import { defaultQuarantineRetentionPolicy } from "./quarantine/types.js";
import { QuarantineService } from "./quarantine/service.js";
import { ReplyClient } from "./reply/client.js";
import { MemoryOutboundQueue } from "./reply/queue.js";
import type { Spool } from "./spool/types.js";

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
  /** Where operational alerts go. Alerts are also counted as metrics. */
  alerts?: AlertSink;
  /** Enable Fastify request logging. */
  logger?: boolean;
  /** The time source. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * The spool shared with the mail path, so `/metrics` can report spool depth
   * and age. When absent the spool gauges are omitted.
   */
  spool?: Spool;
  /** Filesystem paths whose free space is reported on `/metrics`. */
  metricsDiskPaths?: string[];
  /** PEM certificate paths whose expiry is reported on `/metrics`. */
  metricsCertificatePaths?: string[];
  /** Postfix queue probe. Defaults to skipping the queue gauge. */
  postfixQueue?: PostfixQueueProbeOptions | false;
  /** A bearer token that guards `/metrics`. */
  metricsToken?: string;
  /** The metrics registry to record into. Defaults to a fresh registry. */
  metrics?: MetricsRegistry;
}

/** A composed Wickmail server: database, mail store, quarantine, reply, and API. */
export interface WickmailServer {
  app: FastifyInstance;
  db: SqliteDatabase;
  mailStore: FileMailStore;
  quarantine: QuarantineService;
  replyClient: ReplyClient;
  /** The metrics registry backing `/metrics`. */
  metrics: MetricsRegistry;
  /** Refresh the pull-based gauges from the current state. */
  collectMetrics(): Promise<void>;
  /** Close the HTTP server and the database. */
  close(): Promise<void>;
}

/** Record a reconciliation report into the metrics registry. */
export function recordReconciliationMetrics(
  metrics: MetricsRegistry,
  report: ReconciliationReport,
): void {
  metrics.increment(METRIC.reconciliationRunsTotal.name, METRIC.reconciliationRunsTotal.help);
  const increment = (result: string, value: number): void => {
    if (value > 0) {
      metrics.increment(
        METRIC.reconciliationMessagesTotal.name,
        METRIC.reconciliationMessagesTotal.help,
        { result },
        value,
      );
    }
  };
  increment("recovered", report.recovered);
  increment("requarantined", report.requarantined);
  increment("deleted", report.deleted);
  increment("rebuilt", report.rebuilt);
  increment("relinked", report.relinked);
  metrics.set(
    METRIC.reconciliationLastScanned.name,
    METRIC.reconciliationLastScanned.help,
    report.scanned,
  );
}

/** Record a retention report into the metrics registry. */
export function recordRetentionMetrics(metrics: MetricsRegistry, report: RetentionReport): void {
  metrics.increment(METRIC.retentionRunsTotal.name, METRIC.retentionRunsTotal.help);
  const increment = (result: string, value: number): void => {
    if (value > 0) {
      metrics.increment(
        METRIC.retentionMessagesTotal.name,
        METRIC.retentionMessagesTotal.help,
        { result },
        value,
      );
    }
  };
  increment("expired", report.expired);
  increment("quota", report.quota);
  increment("purged", report.purged);
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
  const metrics = config.metrics ?? new MetricsRegistry();
  const alertSink = new MetricsAlertSink(metrics, config.alerts);
  const quarantine = new QuarantineService({
    db,
    store: mailStore,
    ...(config.now !== undefined ? { now: config.now } : {}),
    policy: { ...defaultQuarantineRetentionPolicy(), quota: toQuarantineQuota(limits) },
    onReconciliation: (report) => recordReconciliationMetrics(metrics, report),
    onRetention: (report) => recordRetentionMetrics(metrics, report),
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
    metrics,
  });

  const collectMetrics = async (): Promise<void> => {
    await collectOperationalMetrics(metrics, {
      ...(config.spool !== undefined ? { spool: config.spool } : {}),
      now: (config.now ?? Date.now)(),
      diskPaths: config.metricsDiskPaths ?? [],
      minFreeBytes: limits.minFreeBytes,
      certificatePaths: config.metricsCertificatePaths ?? [],
      postfixQueue: config.postfixQueue ?? false,
    });
    collectQuarantineMetrics(metrics, db);
  };

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
      ...(config.metricsToken !== undefined ? { metricsToken: config.metricsToken } : {}),
    },
    ...(config.now !== undefined ? { now: config.now } : {}),
    ...(config.passwordHasher !== undefined ? { passwordHasher: config.passwordHasher } : {}),
    alerts: alertSink,
    metrics,
    collectMetrics,
    ...(config.logger !== undefined ? { logger: config.logger } : {}),
  });

  return {
    app,
    db,
    mailStore,
    quarantine,
    replyClient,
    metrics,
    collectMetrics,
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
