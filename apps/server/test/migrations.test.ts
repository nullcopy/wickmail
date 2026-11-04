import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appliedVersions,
  migrate,
  migrations,
  openDatabase,
  readPragma,
  rollback,
  type Migration,
  type SqliteDatabase,
} from "../src/db/index.js";
import { createTempDirectory, removeTempDirectory, NOW } from "./helpers.js";

const tables = (db: SqliteDatabase): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);

const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    removeTempDirectory(tempDirectories.pop()!);
  }
});

describe("openDatabase pragmas", () => {
  it("enables write-ahead logging, foreign keys, and a busy timeout", () => {
    const directory = createTempDirectory();
    tempDirectories.push(directory);
    const db = openDatabase({ path: join(directory, "wickmail.db"), busyTimeoutMs: 2500 });
    try {
      expect(readPragma(db, "journal_mode")).toBe("wal");
      expect(readPragma(db, "foreign_keys")).toBe("1");
      expect(readPragma(db, "busy_timeout")).toBe("2500");
    } finally {
      db.close();
    }
  });
});

describe("migrate", () => {
  it("applies every migration forward and is idempotent", () => {
    const db = openDatabase({ path: ":memory:" });
    try {
      expect(appliedVersions(db)).toEqual([]);
      expect(migrate(db, migrations)).toBe(2);
      expect(appliedVersions(db)).toEqual([1, 2]);
      expect(tables(db)).toEqual(
        expect.arrayContaining([
          "aliases",
          "alias_lease_policy",
          "message_provenance",
          "message_provenance_aliases",
          "quarantine_messages",
          "quarantine_message_aliases",
          "audit_events",
          "api_tokens",
          "schema_migrations",
        ]),
      );
      expect(migrate(db, migrations)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("enforces the alias address uniqueness constraint", () => {
    const db = openDatabase({ path: ":memory:" });
    try {
      migrate(db, migrations);
      insertAlias(db, { id: randomUUID(), address: "green.farm@example.com" });
      expect(() =>
        insertAlias(db, { id: randomUUID(), address: "green.farm@example.com" }),
      ).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  it("enforces foreign keys", () => {
    const db = openDatabase({ path: ":memory:" });
    try {
      migrate(db, migrations);
      expect(() =>
        db
          .prepare(
            "INSERT INTO alias_lease_policy (alias_id, lease_duration_seconds, renew_on_outbound) VALUES (?, ?, ?)",
          )
          .run(randomUUID(), 3600, 1),
      ).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
    }
  });
});

describe("rollback", () => {
  it("reverts cleanly and can be re-applied", () => {
    const db = openDatabase({ path: ":memory:" });
    try {
      migrate(db, migrations);
      expect(rollback(db, migrations, { steps: 2 })).toBe(2);
      expect(appliedVersions(db)).toEqual([]);
      expect(tables(db)).not.toContain("aliases");
      expect(migrate(db, migrations)).toBe(2);
      expect(tables(db)).toContain("aliases");
    } finally {
      db.close();
    }
  });

  it("supports reverting to a target version", () => {
    const addNote: Migration = {
      version: 2,
      name: "add_alias_note",
      up: (db) => db.exec("ALTER TABLE aliases ADD COLUMN note TEXT"),
      down: (db) => db.exec("ALTER TABLE aliases DROP COLUMN note"),
    };
    const db = openDatabase({ path: ":memory:" });
    try {
      migrate(db, [migrations[0]!, addNote]);
      expect(appliedVersions(db)).toEqual([1, 2]);
      expect(rollback(db, [migrations[0]!, addNote], { to: 1 })).toBe(1);
      expect(appliedVersions(db)).toEqual([1]);
    } finally {
      db.close();
    }
  });
});

describe("migrations against production-shaped data", () => {
  it("preserves seeded rows across a forward and revert cycle", () => {
    const addNote: Migration = {
      version: 2,
      name: "add_alias_note",
      up: (db) => db.exec("ALTER TABLE aliases ADD COLUMN note TEXT"),
      down: (db) => db.exec("ALTER TABLE aliases DROP COLUMN note"),
    };
    const db = openDatabase({ path: ":memory:" });
    try {
      migrate(db, [migrations[0]!]);
      const aliasId = seedProductionShapedData(db);
      expect(countRows(db, "aliases")).toBe(1);

      migrate(db, [migrations[0]!, addNote]);
      expect(countRows(db, "aliases")).toBe(1);
      expect(countRows(db, "message_provenance_aliases")).toBe(1);
      expect(countRows(db, "quarantine_message_aliases")).toBe(1);
      expect(countRows(db, "audit_events")).toBe(1);
      expect(countRows(db, "api_tokens")).toBe(1);
      expect(db.prepare("SELECT note FROM aliases WHERE id = ?").get(aliasId)).toEqual({
        note: null,
      });

      rollback(db, [migrations[0]!, addNote], { steps: 1 });
      expect(countRows(db, "aliases")).toBe(1);
      expect(countRows(db, "audit_events")).toBe(1);

      rollback(db, [migrations[0]!, addNote], { steps: 1 });
      expect(tables(db)).not.toContain("aliases");
    } finally {
      db.close();
    }
  });
});

function countRows(db: SqliteDatabase, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function insertAlias(db: SqliteDatabase, input: { id: string; address: string }): void {
  db.prepare(
    `INSERT INTO aliases (
       id, address, local_part, domain, label, purpose,
       created_at, expires_at, disabled_at, last_inbound_at, last_user_activity_at, policy_version
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, 0)`,
  ).run(input.id, input.address, "green.farm", "example.com", "Example Store", NOW);
}

function seedProductionShapedData(db: SqliteDatabase): string {
  const aliasId = randomUUID();
  insertAlias(db, { id: aliasId, address: "green.farm@example.com" });
  db.prepare(
    `INSERT INTO alias_lease_policy (alias_id, lease_duration_seconds, renew_on_outbound)
     VALUES (?, ?, ?)`,
  ).run(aliasId, 604800, 1);

  const messageId = `<${randomUUID()}@example.com>`;
  db.prepare(
    `INSERT INTO message_provenance (message_id, primary_received, envelope_recipients, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(messageId, 0, JSON.stringify(["green.farm@example.com"]), NOW);
  db.prepare(`INSERT INTO message_provenance_aliases (message_id, alias_id) VALUES (?, ?)`).run(
    messageId,
    aliasId,
  );

  db.prepare(
    `INSERT INTO quarantine_messages (
       message_id, sender, subject, received_at, quarantine_expires_at, status,
       mailbox, uid_validity, uid, idempotency_key, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    "shop@example.net",
    "Your receipt",
    NOW,
    NOW + 30 * 24 * 60 * 60 * 1000,
    "quarantined",
    "Aliases/Expired",
    1,
    42,
    randomUUID(),
    NOW,
    NOW,
  );
  db.prepare(`INSERT INTO quarantine_message_aliases (message_id, alias_id) VALUES (?, ?)`).run(
    messageId,
    aliasId,
  );

  db.prepare(
    `INSERT INTO audit_events (id, alias_id, type, occurred_at, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), aliasId, "created", NOW, null, NOW);

  db.prepare(
    `INSERT INTO api_tokens (id, name, token_hash, scopes, created_at, expires_at, revoked_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(randomUUID(), "test token", "hash", JSON.stringify(["aliases:read"]), NOW);

  return aliasId;
}
