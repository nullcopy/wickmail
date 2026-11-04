import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, migrate, migrations, type SqliteDatabase } from "../src/db/index.js";
import { FileMailStore } from "../src/mailstore/filesystem.js";
import { QuarantineReconciler } from "../src/quarantine/reconciliation.js";
import {
  getQuarantineEntry,
  recordQuarantinedMessage,
  updateQuarantineStatus,
} from "../src/quarantine/repository.js";
import { defaultQuarantineRetentionPolicy, QUARANTINE_MAILBOX } from "../src/quarantine/types.js";
import { DAY_MS, NOW } from "./helpers.js";
import { createTestAlias } from "./mail-helpers.js";
import { quarantineRaw } from "./quarantine-helpers.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BACKUP_SCRIPT = join(REPO_ROOT, "infra", "scripts", "backup.sh");
const RESTORE_SCRIPT = join(REPO_ROOT, "infra", "scripts", "restore.sh");

const MESSAGE_ID = "01930000-0000-7000-8000-0000000000d1";

let roots: string[] = [];
let db: SqliteDatabase | undefined;

function drillRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wickmail-drill-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  db?.close();
  db = undefined;
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots = [];
});

interface Layout {
  root: string;
  dbPath: string;
  mailDir: string;
  quarantineDir: string;
  spoolDir: string;
  configDir: string;
  backupDir: string;
}

function layout(): Layout {
  const root = drillRoot();
  return {
    root,
    dbPath: join(root, "wickmail.db"),
    mailDir: join(root, "mail"),
    quarantineDir: join(root, "quarantine"),
    spoolDir: join(root, "spool"),
    configDir: join(root, "config"),
    backupDir: join(root, "backups"),
  };
}

function environment(paths: Layout): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WICKMAIL_DB: paths.dbPath,
    WICKMAIL_MAIL_DIR: paths.mailDir,
    WICKMAIL_QUARANTINE_DIR: paths.quarantineDir,
    WICKMAIL_SPOOL_DIR: paths.spoolDir,
    WICKMAIL_CONFIG_DIR: paths.configDir,
    BACKUP_DIR: paths.backupDir,
  };
}

function seedLiveState(paths: Layout): void {
  mkdirSync(paths.mailDir, { recursive: true });
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(join(paths.configDir, "host.env"), "WICKMAIL_DOMAIN=example.com\n");

  db = openDatabase({ path: paths.dbPath });
  migrate(db, migrations);
  const alias = createTestAlias(db, { address: "drill@example.com", expiresAt: NOW - 1000 });

  const store = new FileMailStore({ directory: paths.mailDir });
  const locator = store.put(
    QUARANTINE_MAILBOX,
    MESSAGE_ID,
    quarantineRaw({ messageId: MESSAGE_ID, aliasIds: [alias.id], receivedAt: NOW }),
    NOW,
  );
  recordQuarantinedMessage(db, {
    messageId: MESSAGE_ID,
    aliasIds: [alias.id],
    sender: "sender@example.net",
    subject: "Drill",
    receivedAt: NOW,
    quarantineExpiresAt: NOW + 30 * DAY_MS,
    mailbox: QUARANTINE_MAILBOX,
    locator,
  });
  // Simulate a crash mid-recovery: the metadata says `recovering` but only the
  // quarantine copy exists. Reconciliation after the restore must repair this.
  updateQuarantineStatus(db, MESSAGE_ID, "recovering", { now: NOW });
  db.close();
  db = undefined;
}

function runBackup(paths: Layout): string {
  const output = execFileSync("bash", [BACKUP_SCRIPT], {
    env: environment(paths),
    encoding: "utf8",
  });
  return output.trim();
}

function runRestore(paths: Layout, archive: string, force = false): string {
  const args = force ? ["--force", archive] : [archive];
  return execFileSync("bash", [RESTORE_SCRIPT, ...args], {
    env: environment(paths),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("backup and restore drill", () => {
  it("backs up, restores, and reconciles a quarantined message", async () => {
    const paths = layout();
    seedLiveState(paths);

    const archive = runBackup(paths);
    expect(existsSync(archive)).toBe(true);
    expect(existsSync(`${archive}.sha256`)).toBe(true);

    // Lose the live database, mail store, and configuration.
    rmSync(paths.dbPath, { force: true });
    rmSync(paths.mailDir, { recursive: true, force: true });
    rmSync(paths.configDir, { recursive: true, force: true });
    expect(existsSync(paths.dbPath)).toBe(false);

    runRestore(paths, archive);

    // The restore brought the configuration back.
    expect(readFileSync(join(paths.configDir, "host.env"), "utf8")).toContain("WICKMAIL_DOMAIN");

    db = openDatabase({ path: paths.dbPath });
    const integrity = db.pragma("integrity_check", { simple: true });
    expect(integrity).toBe("ok");

    const store = new FileMailStore({ directory: paths.mailDir });
    const reconciler = new QuarantineReconciler({
      db,
      store,
      policy: defaultQuarantineRetentionPolicy(),
      now: () => NOW,
    });
    const report = await reconciler.runOnce();

    expect(report.scanned).toBeGreaterThanOrEqual(1);
    expect(report.requarantined).toBeGreaterThanOrEqual(1);
    expect(getQuarantineEntry(db, MESSAGE_ID)?.status).toBe("quarantined");
    expect(await store.getMessageIn(QUARANTINE_MAILBOX, MESSAGE_ID)).toBeDefined();

    db.close();
    db = undefined;
  });

  it("refuses to overwrite existing state without --force", () => {
    const paths = layout();
    seedLiveState(paths);
    const archive = runBackup(paths);

    expect(() => runRestore(paths, archive)).toThrow();
    // With --force the restore proceeds.
    expect(() => runRestore(paths, archive, true)).not.toThrow();
  });

  it("rejects an archive whose checksum does not match", () => {
    const paths = layout();
    seedLiveState(paths);
    const archive = runBackup(paths);
    writeFileSync(
      `${archive}.sha256`,
      "0000000000000000000000000000000000000000000000000000000000000000\n",
    );
    expect(() => runRestore(paths, archive)).toThrow();
  });
});
