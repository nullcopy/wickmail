import Database from "better-sqlite3";

/** The `better-sqlite3` database instance type. */
export type SqliteDatabase = Database.Database;

/** Options for opening a Wickmail database. */
export interface OpenDatabaseOptions {
  /** The database file, or `:memory:` for an ephemeral database. */
  path: string;
  /** Busy timeout in milliseconds. Defaults to five seconds. */
  busyTimeoutMs?: number;
}

/**
 * Open a database with the pragmas Wickmail relies on: write-ahead logging,
 * foreign keys, and a busy timeout. A single process owns writes.
 */
export function openDatabase(options: OpenDatabaseOptions): SqliteDatabase {
  const db = new Database(options.path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  db.pragma("synchronous = NORMAL");
  return db;
}

/** Read a pragma value as a string. */
export function readPragma(db: SqliteDatabase, pragma: string): string {
  const row = db.pragma(pragma, { simple: true });
  return String(row);
}
