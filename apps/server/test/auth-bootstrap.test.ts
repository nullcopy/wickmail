import { afterEach, describe, expect, it } from "vitest";
import { argon2idHasher, isArgon2idHash } from "../src/auth/password.js";
import { consumeSetupToken } from "../src/auth/setup.js";
import { countUsers, getUserByUsername } from "../src/auth/users.js";
import { runAdminCli } from "../src/cli/admin.js";
import { createTestDatabase, NOW } from "./helpers.js";

function collector(): {
  out: string[];
  err: string[];
  io: { out: (l: string) => void; err: (l: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
  };
}

describe("argon2id password hashing", () => {
  it("hashes with Argon2id and verifies correctly", async () => {
    const hash = await argon2idHasher.hash("correct horse battery staple");
    expect(isArgon2idHash(hash)).toBe(true);
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await argon2idHasher.verify(hash, "correct horse battery staple")).toBe(true);
    expect(await argon2idHasher.verify(hash, "wrong")).toBe(false);
  });

  it("salts each hash so the same password hashes differently", async () => {
    const first = await argon2idHasher.hash("same password");
    const second = await argon2idHasher.hash("same password");
    expect(first).not.toBe(second);
  });
});

describe("bootstrap CLI", () => {
  it("creates the user and prints a single-use setup token with no default password", async () => {
    const db = createTestDatabase();
    try {
      const { out, io } = collector();
      const code = await runAdminCli(
        ["bootstrap", "--username", "owner"],
        { db, now: () => NOW },
        io,
      );
      expect(code).toBe(0);
      expect(countUsers(db)).toBe(1);
      const user = getUserByUsername(db, "owner");
      expect(user).toBeDefined();
      expect(user!.passwordHash).toBeNull();

      const tokenLine = out.find((line) => line.startsWith("wmksetup_"));
      expect(tokenLine).toBeDefined();

      // The token is stored only as a hash: it is consumable once.
      expect(consumeSetupToken(db, tokenLine!, NOW)).toEqual({ userId: user!.id });
      expect(consumeSetupToken(db, tokenLine!, NOW)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("refuses to bootstrap twice", async () => {
    const db = createTestDatabase();
    try {
      const first = collector();
      expect(await runAdminCli(["bootstrap"], { db, now: () => NOW }, first.io)).toBe(0);
      const second = collector();
      expect(await runAdminCli(["bootstrap"], { db, now: () => NOW }, second.io)).toBe(1);
      expect(second.err.join("\n")).toContain("already exists");
    } finally {
      db.close();
    }
  });
});
