import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServerProcess, type ServerProcess } from "../src/main.js";

const ENV_KEYS = [
  "WICKMAIL_DOMAIN",
  "WICKMAIL_DB",
  "WICKMAIL_MAIL_DIR",
  "WICKMAIL_SPOOL_DIR",
  "WICKMAIL_POLICY_SOCKET",
  "WICKMAIL_LMTP_SOCKET",
  "WICKMAIL_LMTP_TARGET",
  "WICKMAIL_API_PORT",
  "WICKMAIL_METRICS_DISK_PATHS",
] as const;

let running: ServerProcess | undefined;
let directory: string | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  if (directory !== undefined) {
    rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe("server process", () => {
  it("composes the API, mail path, and metrics from the environment", async () => {
    directory = mkdtempSync(join(tmpdir(), "wickmail-process-"));
    process.env.WICKMAIL_DOMAIN = "example.com";
    process.env.WICKMAIL_DB = join(directory, "wickmail.db");
    process.env.WICKMAIL_MAIL_DIR = join(directory, "mail");
    process.env.WICKMAIL_SPOOL_DIR = join(directory, "spool");
    process.env.WICKMAIL_POLICY_SOCKET = join(directory, "policy.sock");
    process.env.WICKMAIL_LMTP_SOCKET = join(directory, "lmtp.sock");
    process.env.WICKMAIL_LMTP_TARGET = join(directory, "dovecot.sock");
    process.env.WICKMAIL_API_PORT = "0";

    running = await startServerProcess();
    const response = await running.server.app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("wickmail_spool_depth");
  });
});
