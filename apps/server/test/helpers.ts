import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations, openDatabase, type SqliteDatabase } from "../src/db/index.js";

/** Open an in-memory database with every migration applied. */
export function createTestDatabase(): SqliteDatabase {
  const db = openDatabase({ path: ":memory:" });
  migrate(db, migrations);
  return db;
}

/** Create a temporary directory for a file-backed database. */
export function createTempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "wickmail-test-"));
}

/** Remove a temporary directory created by {@link createTempDirectory}. */
export function removeTempDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

/** One day in milliseconds. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The domain used by tests. */
export const TEST_DOMAIN = "example.com";

/** A fixed instant used by tests, in epoch milliseconds. */
export const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
