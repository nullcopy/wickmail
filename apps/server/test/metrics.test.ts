import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryAlertSink } from "../src/abuse/disk.js";
import { MailProxy } from "../src/lmtp/proxy.js";
import { MetricsAlertSink } from "../src/metrics/alerts.js";
import { certificateExpiry } from "../src/metrics/certificate.js";
import { collectOperationalMetrics, collectQuarantineMetrics } from "../src/metrics/collect.js";
import { METRIC } from "../src/metrics/names.js";
import { countPostfixQueue, readPostfixQueueDepth } from "../src/metrics/postfix.js";
import { MetricsRegistry } from "../src/metrics/registry.js";
import { SpoolFullError, type Spool } from "../src/spool/types.js";
import { createWickmailServer, type WickmailServer } from "../src/server.js";
import { createTestDatabase, createTempDirectory, NOW, removeTempDirectory } from "./helpers.js";

const CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDEzCCAfugAwIBAgIUW6l11MALu9tAs4IDyh0k7ij/T4UwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNd2lja21haWwudGVzdDAgFw0yNjExMDQwNDIyMTRaGA8y
MTI2MTAxMTA0MjIxNFowGDEWMBQGA1UEAwwNd2lja21haWwudGVzdDCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAMYw2OW1djWiORQqKBLFnCJDdoAs/Z4t
j1pmmCw6evtNMCyQSrOxDYrK01QnOWO/fKxP+ICQ+QdvOesSdU5Km721IC0231p+
TOi69mjWvAywQSHXsPM1KiypPtgEXqGheGZR4EtStP5l5f4uRST8wKB/RZQXUy9P
PrVvFAeXS5moSZpEusBNBQ5e4gDzvW1fJyCBh+EQdpXV+cNogiWKo6T/rWCpOIWA
6Dl4zYMhuZXZLAj4fcEFnk8s4ycqJ15P7TvfUD3D3BP+qVCUjdduU3QtBtzotZDy
3IaAYwYFjrXFLNtr+LOV15DNtPi/tQMVYdvBhqWMRkrXvE0hyhfjOEcCAwEAAaNT
MFEwHQYDVR0OBBYEFLG98R1GtWKoYbQYgfnviUk8L0WXMB8GA1UdIwQYMBaAFLG9
8R1GtWKoYbQYgfnviUk8L0WXMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEL
BQADggEBAGS6rZz1bAHIZakCYqLzgtbFCJyNrKeVqTwIiWuOHW+WzkAqUIuGw2gx
qY9Vjhenm0Co8/PhGChQB6HQrkfHWK1GVkGU2W5zhDUeO3kIguZ8sbBU1RNcevTo
wm7XW1JuvldxL3TQFkzb1gBavqpZlWICFDSyK3iQm2hP0XOYuCYFyT8DPrkuTL+S
cMwrFpd5dewaDO2hlPO+pVL6THF9b8lNnda6e6eTjYU7qLmjcVNHmbp+6o3WZnyM
mNZA5XcmjXDqgZYC0xJ5qg7IFQiPc1qYoGzCHqDR2eYLCFkW0qUoBzClaOVOLf/E
voEZwdUGPOR+hxmh6++W8lIRdzUEv9g=
-----END CERTIFICATE-----
`;

const tempDirectories: string[] = [];
let server: WickmailServer | undefined;

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "wickmail-metrics-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function memorySpool(overrides: Partial<Spool> = {}): Spool {
  return {
    async enqueue() {},
    async list() {
      return [];
    },
    async get() {
      return undefined;
    },
    async remove() {},
    async recordAttempt() {},
    async stats() {
      return { depth: 0, oldestAgeMs: null };
    },
    ...overrides,
  };
}

describe("metrics registry", () => {
  it("renders counters and gauges in the Prometheus text format", () => {
    const registry = new MetricsRegistry();
    registry.increment("wickmail_thing_total", "A counter.", { kind: "a" });
    registry.increment("wickmail_thing_total", "A counter.", { kind: "a" }, 2);
    registry.set("wickmail_gauge", "A gauge.", 4.5, { path: "/var" });

    const text = registry.render();
    expect(text).toContain("# TYPE wickmail_thing_total counter");
    expect(text).toContain('wickmail_thing_total{kind="a"} 3');
    expect(text).toContain("# TYPE wickmail_gauge gauge");
    expect(text).toContain('wickmail_gauge{path="/var"} 4.5');
    expect(registry.get("wickmail_thing_total", { kind: "a" })).toBe(3);
  });

  it("escapes label values and renders non-finite values", () => {
    const registry = new MetricsRegistry();
    registry.set("wickmail_gauge", "A gauge.", Number.POSITIVE_INFINITY, { path: 'a"b\\c' });
    const text = registry.render();
    expect(text).toContain('path="a\\"b\\\\c"');
    expect(text).toContain("+Inf");
  });
});

describe("certificate expiry", () => {
  it("reads the not-after time and remaining seconds", () => {
    const directory = tempDirectory();
    const path = join(directory, "cert.pem");
    writeFileSync(path, CERTIFICATE);

    const expiry = certificateExpiry(path, NOW);
    expect(expiry).toBeDefined();
    expect(expiry!.notAfter).toBeGreaterThan(Date.UTC(2100, 0, 1));
    expect(expiry!.secondsRemaining).toBeGreaterThan(0);
  });

  it("returns undefined for a missing or invalid certificate", () => {
    expect(certificateExpiry("/nonexistent/cert.pem", NOW)).toBeUndefined();
  });
});

describe("postfix queue probe", () => {
  it("counts JSON lines and ignores malformed input", () => {
    const output = '{"queue_id":"1"}\n{"queue_id":"2"}\n\nnot json\n';
    expect(countPostfixQueue(output)).toBe(2);
  });

  it("reads the depth from a collector file", () => {
    const directory = tempDirectory();
    const path = join(directory, "queue.jsonl");
    writeFileSync(path, '{"queue_id":"1"}\n{"queue_id":"2"}\n{"queue_id":"3"}\n');
    expect(readPostfixQueueDepth({ file: path })).toBe(3);
  });

  it("returns undefined when the command is unavailable", () => {
    expect(readPostfixQueueDepth({ command: "definitely-not-a-wickmail-command" })).toBeUndefined();
  });
});

describe("operational metric collection", () => {
  it("collects spool, disk, certificate, and queue gauges", async () => {
    const registry = new MetricsRegistry();
    const directory = tempDirectory();
    const certificatePath = join(directory, "cert.pem");
    writeFileSync(certificatePath, CERTIFICATE);

    await collectOperationalMetrics(registry, {
      spool: memorySpool({
        async stats() {
          return { depth: 3, oldestAgeMs: 1500 };
        },
      }),
      now: NOW,
      diskPaths: [directory],
      minFreeBytes: 0,
      certificatePaths: [certificatePath],
      postfixQueue: { file: join(directory, "queue.jsonl") },
    });

    expect(registry.get(METRIC.spoolDepth.name)).toBe(3);
    expect(registry.get(METRIC.spoolOldestAgeSeconds.name)).toBe(1.5);
    expect(registry.get(METRIC.diskFreeBytes.name, { path: directory })).toBeGreaterThan(0);
    expect(registry.get(METRIC.diskOk.name, { path: directory })).toBe(1);
    expect(
      registry.get(METRIC.certificateExpiryDays.name, { path: certificatePath }),
    ).toBeGreaterThan(0);
  });

  it("counts quarantine metadata by status", () => {
    const db = createTestDatabase();
    const registry = new MetricsRegistry();
    collectQuarantineMetrics(registry, db);
    // An empty store simply has no samples rather than a zero value.
    expect(registry.samples(METRIC.quarantineEntries.name)).toHaveLength(0);
    db.close();
  });
});

describe("alert metric sink", () => {
  it("counts alerts and forwards them", () => {
    const registry = new MetricsRegistry();
    const inner = new MemoryAlertSink();
    const sink = new MetricsAlertSink(registry, inner);
    sink.alert({ kind: "disk_full", message: "full", at: NOW });
    sink.alert({ kind: "disk_full", message: "full", at: NOW });
    expect(registry.get(METRIC.alertsTotal.name, { kind: "disk_full" })).toBe(2);
    expect(inner.ofKind("disk_full")).toHaveLength(2);
  });
});

describe("mail path metrics", () => {
  it("counts accepted messages and deferred stages", async () => {
    const db = createTestDatabase();
    const registry = new MetricsRegistry();
    const alerts = new MetricsAlertSink(registry);
    const proxy = new MailProxy({
      db,
      spool: memorySpool(),
      localDomains: ["example.com"],
      primaryAddresses: ["me@example.com"],
      now: () => NOW,
      metrics: registry,
      alerts,
    });

    const accepted = await proxy.deliver({
      mailFrom: "sender@example.net",
      rcptTo: ["me@example.com"],
      data: "Subject: hi\r\n\r\nbody",
      receivedAt: NOW,
    });
    expect(accepted.status).toBe("accepted");
    expect(registry.get(METRIC.messagesAcceptedTotal.name, { route: "Inbox" })).toBe(1);

    const full = new MailProxy({
      db,
      spool: memorySpool({
        async enqueue() {
          throw new SpoolFullError("spool filesystem is full");
        },
      }),
      localDomains: ["example.com"],
      primaryAddresses: ["me@example.com"],
      now: () => NOW,
      metrics: registry,
      alerts,
    });
    const deferred = await full.deliver({
      mailFrom: "sender@example.net",
      rcptTo: ["me@example.com"],
      data: "Subject: hi\r\n\r\nbody",
      receivedAt: NOW,
    });
    expect(deferred.status).toBe("tempfail");
    expect(registry.get(METRIC.messagesTempfailedTotal.name, { stage: "spool" })).toBe(1);
    expect(registry.get(METRIC.alertsTotal.name, { kind: "disk_full" })).toBe(1);
    db.close();
  });
});

describe("metrics endpoint", () => {
  it("serves Prometheus text and counts authentication failures", async () => {
    const directory = tempDirectory();
    server = await createWickmailServer({
      databasePath: join(directory, "wickmail.db"),
      domain: "example.com",
      mailStoreDirectory: join(directory, "mail"),
      now: () => NOW,
      passwordHasher: {
        async hash(password: string) {
          return `test:${password}`;
        },
        async verify(hash: string, password: string) {
          return hash === `test:${password}`;
        },
      },
    });

    await server.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { username: "admin", password: "wrong" },
    });

    await server.quarantine.reconcile();
    expect(server.metrics.get(METRIC.reconciliationRunsTotal.name)).toBe(1);

    const response = await server.app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("# TYPE wickmail_auth_failures_total counter");
    expect(response.body).toContain('wickmail_auth_failures_total{method="password"} 1');
  });

  it("requires the configured bearer token", async () => {
    const directory = tempDirectory();
    server = await createWickmailServer({
      databasePath: join(directory, "wickmail.db"),
      domain: "example.com",
      mailStoreDirectory: join(directory, "mail"),
      metricsToken: "secret-token",
    });

    const denied = await server.app.inject({ method: "GET", url: "/metrics" });
    expect(denied.statusCode).toBe(401);

    const allowed = await server.app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer secret-token" },
    });
    expect(allowed.statusCode).toBe(200);
  });
});
