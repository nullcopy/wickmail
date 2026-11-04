import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:net";
import type { AlertSink } from "./abuse/disk.js";
import type { SlidingWindowRateLimiter } from "./abuse/rateLimit.js";
import type { MailPathConfig } from "./config.js";
import type { SqliteDatabase } from "./db/database.js";
import type { DeliveryTarget } from "./delivery/target.js";
import { MailProxy, type InboundRateLimits } from "./lmtp/proxy.js";
import { createLmtpServer } from "./lmtp/server.js";
import { createRecipientPolicy, type RecipientPolicy } from "./policy/recipient.js";
import { createSocketmapServer } from "./policy/socketmap.js";
import { FileSpool } from "./spool/file-spool.js";
import { SpoolWorker } from "./spool/worker.js";
import type { Spool } from "./spool/types.js";

/** A socket endpoint for a mail-path listener. */
export interface ListenEndpoint {
  /** A Unix socket path; mutually exclusive with `port`. */
  path?: string;
  /** A TCP host. Defaults to `127.0.0.1`. */
  host?: string;
  /** A TCP port; `0` selects an ephemeral port. */
  port?: number;
}

/** Options for {@link createMailPath}. */
export interface MailPathOptions {
  db: SqliteDatabase;
  config: MailPathConfig;
  /** The downstream delivery target drained by the spool worker. */
  target: DeliveryTarget;
  /** The time source. Defaults to `Date.now`. */
  now?: () => number;
  /** The spool implementation. Defaults to a {@link FileSpool}. */
  spool?: Spool;
  /** An inbound rate limiter, shared with the management API. */
  rateLimiter?: SlidingWindowRateLimiter;
  /** Inbound rate limits. Required for inbound rate limiting to apply. */
  rateLimits?: InboundRateLimits;
  /** Where operational alerts go. */
  alerts?: AlertSink;
}

/**
 * The assembled inbound mail path: recipient policy, socketmap server, LMTP
 * proxy, durable spool, and the spool worker that forwards to the downstream
 * delivery target.
 */
export class MailPath {
  readonly spool: Spool;
  readonly proxy: MailProxy;
  readonly worker: SpoolWorker;
  readonly recipientPolicy: RecipientPolicy;
  readonly socketmap: Server;
  readonly lmtp: Server;

  constructor(private readonly options: MailPathOptions) {
    const { db, config } = options;
    this.spool = options.spool ?? new FileSpool({ directory: config.spoolDirectory });
    this.proxy = new MailProxy({
      db,
      spool: this.spool,
      localDomains: config.localDomains,
      primaryAddresses: config.primaryAddresses,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.rateLimiter !== undefined ? { rateLimiter: options.rateLimiter } : {}),
      ...(options.rateLimits !== undefined ? { rateLimits: options.rateLimits } : {}),
      ...(options.alerts !== undefined ? { alerts: options.alerts } : {}),
    });
    this.worker = new SpoolWorker(this.spool, options.target, {
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.recipientPolicy = createRecipientPolicy({
      db,
      primaryAddresses: config.primaryAddresses,
      localDomains: config.localDomains,
    });
    this.socketmap = createSocketmapServer({
      mapName: "recipient",
      evaluate: (key) => this.recipientPolicy.evaluate(key, (options.now ?? Date.now)()),
    });
    this.lmtp = createLmtpServer({
      proxy: this.proxy,
      hostname: config.hostname,
      localDomains: config.localDomains,
      ...(config.maxMessageBytes !== undefined ? { maxMessageBytes: config.maxMessageBytes } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }

  /** Bind the policy socketmap server. */
  listenPolicy(endpoint: ListenEndpoint): Promise<AddressInfo | { path: string }> {
    return listen(this.socketmap, endpoint);
  }

  /** Bind the LMTP server. */
  listenLmtp(endpoint: ListenEndpoint): Promise<AddressInfo | { path: string }> {
    return listen(this.lmtp, endpoint);
  }

  /** Close both listeners. */
  async close(): Promise<void> {
    await Promise.all([close(this.socketmap), close(this.lmtp)]);
  }
}

/** Build a mail path from configuration. */
export function createMailPath(options: MailPathOptions): MailPath {
  return new MailPath(options);
}

/** Remove a Unix socket file if it exists. */
export function removeSocketFile(path: string): void {
  rmSync(path, { force: true });
}

function listen(server: Server, endpoint: ListenEndpoint): Promise<AddressInfo | { path: string }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    if (endpoint.path !== undefined) {
      removeSocketFile(endpoint.path);
      server.listen(endpoint.path, () => resolve({ path: endpoint.path! }));
    } else {
      server.listen(endpoint.port ?? 0, endpoint.host ?? "127.0.0.1", () =>
        resolve(server.address() as AddressInfo),
      );
    }
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
