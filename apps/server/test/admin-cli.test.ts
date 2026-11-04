import { afterEach, describe, expect, it } from "vitest";
import { listApiTokens } from "../src/auth/apiTokens.js";
import { countUnusedRecoveryCodes } from "../src/auth/recovery.js";
import { getActiveMailCredential, verifyMailCredential } from "../src/auth/mailCredential.js";
import { getSoleUser } from "../src/auth/users.js";
import { runAdminCli, type AdminCliIo } from "../src/cli/admin.js";
import type { SqliteDatabase } from "../src/db/database.js";
import { fastPasswordHasher } from "./api-helpers.js";
import { createTempDirectory, createTestDatabase, NOW, removeTempDirectory } from "./helpers.js";

let db: SqliteDatabase | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function collector(): { out: string[]; err: string[]; io: AdminCliIo } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } };
}

function deps(database: SqliteDatabase) {
  return { db: database, now: () => NOW, passwordHasher: fastPasswordHasher() };
}

describe("admin CLI", () => {
  it("completes bootstrap, setup, and recovery-code flows", async () => {
    db = createTestDatabase();
    const bootstrap = collector();
    expect(await runAdminCli(["bootstrap"], deps(db), bootstrap.io)).toBe(0);
    const token = bootstrap.out.find((line) => line.startsWith("wmksetup_"))!;

    const setup = collector();
    expect(
      await runAdminCli(
        ["setup", "--token", token, "--password", "a long management password"],
        deps(db),
        setup.io,
      ),
    ).toBe(0);
    expect(setup.out.join("\n")).toContain("management password set");
    const user = getSoleUser(db)!;
    expect(user.passwordHash).not.toBeNull();
    expect(countUnusedRecoveryCodes(db, user.id)).toBeGreaterThan(0);

    const reuse = collector();
    expect(
      await runAdminCli(
        ["setup", "--token", token, "--password", "another long password"],
        deps(db),
        reuse.io,
      ),
    ).toBe(1);

    const reset = collector();
    expect(
      await runAdminCli(["password", "--password", "reset long password"], deps(db), reset.io),
    ).toBe(0);

    const codes = collector();
    expect(await runAdminCli(["recovery-codes"], deps(db), codes.io)).toBe(0);
    expect(codes.out.filter((line) => /^[A-Z2-9]{5}-/.test(line)).length).toBeGreaterThan(0);
  });

  it("rotates and revokes the mail credential", async () => {
    db = createTestDatabase();
    await runAdminCli(["bootstrap"], deps(db), collector().io);
    const rotate = collector();
    expect(await runAdminCli(["mail-password"], deps(db), rotate.io)).toBe(0);
    const generated = rotate.out.find((line) => line.includes("generated mail password"))!;
    const password = generated.split(": ")[1]!;
    const user = getSoleUser(db)!;
    expect(getActiveMailCredential(db, user.id)).toBeDefined();
    expect(await verifyMailCredential(db, user.id, password, fastPasswordHasher())).toBe(true);

    const revoke = collector();
    expect(await runAdminCli(["revoke-mail-credential"], deps(db), revoke.io)).toBe(0);
    expect(getActiveMailCredential(db, user.id)).toBeUndefined();
  });

  it("creates, lists, and revokes API tokens", async () => {
    db = createTestDatabase();
    await runAdminCli(["bootstrap"], deps(db), collector().io);

    const create = collector();
    expect(
      await runAdminCli(
        ["token", "create", "--name", "ci", "--scopes", "aliases:read,quarantine:read"],
        deps(db),
        create.io,
      ),
    ).toBe(0);
    const secret = create.out.find((line) => line.startsWith("wmk_"))!;
    expect(secret).toBeDefined();
    const tokens = listApiTokens(db);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.scopes).toEqual(["aliases:read", "quarantine:read"]);

    const list = collector();
    expect(await runAdminCli(["token", "list"], deps(db), list.io)).toBe(0);
    expect(list.out[0]).toContain("ci");

    const revoke = collector();
    expect(await runAdminCli(["token", "revoke", "--id", tokens[0]!.id], deps(db), revoke.io)).toBe(
      0,
    );
    expect(listApiTokens(db)[0]!.revokedAt).not.toBeNull();
  });

  it("rejects unknown scopes", async () => {
    db = createTestDatabase();
    await runAdminCli(["bootstrap"], deps(db), collector().io);
    const create = collector();
    expect(
      await runAdminCli(
        ["token", "create", "--name", "bad", "--scopes", "root"],
        deps(db),
        create.io,
      ),
    ).toBe(1);
    expect(create.err.join("\n")).toContain("unknown scope");
  });

  it("reconciles the quarantine metadata with the mail store", async () => {
    db = createTestDatabase();
    const directory = createTempDirectory();
    try {
      const missing = collector();
      expect(await runAdminCli(["reconcile"], deps(db), missing.io)).toBe(2);
      expect(missing.err.join("\n")).toContain("mail store directory");

      const reconciled = collector();
      const code = await runAdminCli(
        ["reconcile"],
        { ...deps(db), mailStoreDirectory: directory },
        reconciled.io,
      );
      expect(code).toBe(0);
      const report = JSON.parse(reconciled.out.join("\n")) as { scanned: number };
      expect(report.scanned).toBe(0);
    } finally {
      removeTempDirectory(directory);
    }
  });
});
