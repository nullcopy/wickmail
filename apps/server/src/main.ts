import { pathToFileURL } from "node:url";
import { LmtpDeliveryTarget } from "./delivery/lmtp-target.js";
import { LmtpClient } from "./lmtp/client.js";
import { createMailPath, type MailPath } from "./mail-path.js";
import { MetricsAlertSink } from "./metrics/alerts.js";
import { MetricsRegistry } from "./metrics/registry.js";
import { createWickmailServer, type WickmailServer } from "./server.js";
import { FileSpool } from "./spool/file-spool.js";

/**
 * The process entry point for the packaged `wickmail-server`.
 *
 * It reads host-specific values from the environment (the NixOS module sets
 * them), composes the management API and the inbound mail path on one SQLite
 * database, and listens on the API, policy, and LMTP sockets. Nothing here has
 * a default credential: bootstrap runs separately through the admin CLI.
 *
 * Environment:
 *   WICKMAIL_DB                    SQLite database (default /var/lib/wickmail/wickmail.db)
 *   WICKMAIL_DOMAIN                authoritative domain (required)
 *   WICKMAIL_PRIMARY_ADDRESS       primary mailbox address (optional)
 *   WICKMAIL_HOSTNAME              advertised host name (default mail.$WICKMAIL_DOMAIN)
 *   WICKMAIL_MAIL_DIR              mail-store root (default /var/vmail)
 *   WICKMAIL_SPOOL_DIR             durable spool (default /var/lib/wickmail/spool)
 *   WICKMAIL_POLICY_SOCKET         Postfix socketmap socket (default /run/wickmail/policy.sock)
 *   WICKMAIL_LMTP_SOCKET           inbound LMTP listen socket (default /run/wickmail/lmtp.sock)
 *   WICKMAIL_LMTP_TARGET           downstream LMTP socket (default /run/dovecot/lmtp)
 *   WICKMAIL_API_HOST              API bind address (default 127.0.0.1)
 *   WICKMAIL_API_PORT              API port (default 8080)
 *   WICKMAIL_SECURE_COOKIES        "false" to disable the Secure cookie flag
 *   WICKMAIL_METRICS_DISK_PATHS    colon-separated filesystem paths for disk gauges
 *   WICKMAIL_METRICS_CERTIFICATE_PATHS  colon-separated PEM paths for expiry gauges
 *   WICKMAIL_POSTFIX_QUEUE_FILE    file holding `postqueue -j` output for the queue gauge
 *   WICKMAIL_METRICS_TOKEN         bearer token guarding /metrics (optional)
 *   WICKMAIL_LOG                   "true" to enable request logging
 */
export interface ServerProcess {
  server: WickmailServer;
  mailPath: MailPath;
  close(): Promise<void>;
}

function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? fallback : value;
}

function splitPaths(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(":")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Compose and start the server process from the environment. */
export async function startServerProcess(): Promise<ServerProcess> {
  const domain = env("WICKMAIL_DOMAIN");
  if (domain === undefined) {
    throw new Error("WICKMAIL_DOMAIN is required");
  }
  const databasePath = env("WICKMAIL_DB", "/var/lib/wickmail/wickmail.db")!;
  const mailStoreDirectory = env("WICKMAIL_MAIL_DIR", "/var/vmail")!;
  const spoolDirectory = env("WICKMAIL_SPOOL_DIR", "/var/lib/wickmail/spool")!;
  const policySocket = env("WICKMAIL_POLICY_SOCKET", "/run/wickmail/policy.sock")!;
  const lmtpSocket = env("WICKMAIL_LMTP_SOCKET", "/run/wickmail/lmtp.sock")!;
  const lmtpTarget = env("WICKMAIL_LMTP_TARGET", "/run/dovecot/lmtp")!;
  const hostname = env("WICKMAIL_HOSTNAME", `mail.${domain}`)!;
  const primaryAddress = env("WICKMAIL_PRIMARY_ADDRESS");

  const metrics = new MetricsRegistry();
  const alerts = new MetricsAlertSink(metrics);
  const spool = new FileSpool({ directory: spoolDirectory });

  const configuredDiskPaths = splitPaths(env("WICKMAIL_METRICS_DISK_PATHS"));
  const metricsDiskPaths =
    configuredDiskPaths.length > 0 ? configuredDiskPaths : [spoolDirectory, mailStoreDirectory];
  const postfixQueueFile = env("WICKMAIL_POSTFIX_QUEUE_FILE");

  const server = await createWickmailServer({
    databasePath,
    domain,
    primaryAddress: primaryAddress ?? null,
    mailStoreDirectory,
    spool,
    metrics,
    secureCookies: env("WICKMAIL_SECURE_COOKIES", "true") !== "false",
    logger: env("WICKMAIL_LOG") === "true",
    metricsDiskPaths,
    metricsCertificatePaths: splitPaths(env("WICKMAIL_METRICS_CERTIFICATE_PATHS")),
    ...(postfixQueueFile !== undefined ? { postfixQueue: { file: postfixQueueFile } } : {}),
    ...(env("WICKMAIL_METRICS_TOKEN") !== undefined
      ? { metricsToken: env("WICKMAIL_METRICS_TOKEN")! }
      : {}),
  });

  const mailPath = createMailPath({
    db: server.db,
    config: {
      hostname,
      localDomains: [domain],
      primaryAddresses: primaryAddress ? [primaryAddress] : [],
      spoolDirectory,
      policySocketPath: policySocket,
      lmtpSocketPath: lmtpSocket,
    },
    target: new LmtpDeliveryTarget(new LmtpClient({ path: lmtpTarget, hostname })),
    spool,
    alerts,
    metrics,
  });

  await mailPath.listenPolicy({ path: policySocket });
  await mailPath.listenLmtp({ path: lmtpSocket });
  await server.app.listen({
    host: env("WICKMAIL_API_HOST", "127.0.0.1")!,
    port: Number(env("WICKMAIL_API_PORT", "8080")),
  });

  return {
    server,
    mailPath,
    async close(): Promise<void> {
      await mailPath.close();
      await server.close();
    },
  };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void startServerProcess().then((running) => {
    const shutdown = (): void => {
      void running.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
