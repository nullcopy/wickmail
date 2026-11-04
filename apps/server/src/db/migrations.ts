import type { SqliteDatabase } from "./database.js";

/** A single, reversible schema migration. */
export interface Migration {
  /** A monotonically increasing version. */
  version: number;
  /** A short human-readable name. */
  name: string;
  /** Apply the migration. */
  up: (db: SqliteDatabase) => void;
  /** Revert the migration. */
  down: (db: SqliteDatabase) => void;
}

/** The table that records applied migrations. */
const MIGRATIONS_TABLE = "schema_migrations";

/** Create the migrations bookkeeping table when it does not exist. */
export function ensureMigrationsTable(db: SqliteDatabase): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at INTEGER NOT NULL
     )`,
  );
}

/** The versions that have been applied, ascending. */
export function appliedVersions(db: SqliteDatabase): number[] {
  ensureMigrationsTable(db);
  const rows = db
    .prepare(`SELECT version FROM ${MIGRATIONS_TABLE} ORDER BY version ASC`)
    .all() as Array<{ version: number }>;
  return rows.map((row) => row.version);
}

function sortByVersion(migrations: readonly Migration[]): Migration[] {
  return [...migrations].sort((left, right) => left.version - right.version);
}

function assertUniqueVersions(migrations: readonly Migration[]): void {
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      throw new Error(`duplicate migration version ${migration.version}`);
    }
    seen.add(migration.version);
  }
}

/**
 * Apply every pending migration in version order. Each migration and its
 * bookkeeping row commit together, so a failure leaves the schema at the last
 * fully applied version.
 */
export function migrate(db: SqliteDatabase, migrations: readonly Migration[]): number {
  assertUniqueVersions(migrations);
  ensureMigrationsTable(db);
  const applied = new Set(appliedVersions(db));
  const pending = sortByVersion(migrations).filter((migration) => !applied.has(migration.version));

  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db);
      db.prepare(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`,
      ).run(migration.version, migration.name, Date.now());
    });
    apply();
  }

  return pending.length;
}

/** Options for reverting migrations. */
export interface RollbackOptions {
  /** Revert this many of the most recent migrations. Defaults to one. */
  steps?: number;
  /** Revert every migration with a version greater than this value. */
  to?: number;
}

/**
 * Revert applied migrations in reverse version order. Each revert and its
 * bookkeeping delete commit together.
 */
export function rollback(
  db: SqliteDatabase,
  migrations: readonly Migration[],
  options: RollbackOptions = {},
): number {
  assertUniqueVersions(migrations);
  ensureMigrationsTable(db);
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const appliedDescending = appliedVersions(db).sort((left, right) => right - left);
  const steps = options.steps ?? 1;

  let reverted = 0;
  for (const version of appliedDescending) {
    if (options.to !== undefined) {
      if (version <= options.to) {
        break;
      }
    } else if (reverted >= steps) {
      break;
    }

    const migration = byVersion.get(version);
    if (migration === undefined) {
      throw new Error(`no migration is defined for applied version ${version}`);
    }

    const revert = db.transaction(() => {
      migration.down(db);
      db.prepare(`DELETE FROM ${MIGRATIONS_TABLE} WHERE version = ?`).run(migration.version);
    });
    revert();
    reverted += 1;
  }

  return reverted;
}
