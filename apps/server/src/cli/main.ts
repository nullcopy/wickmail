import { pathToFileURL } from "node:url";
import { openDatabase } from "../db/database.js";
import { migrate } from "../db/migrations.js";
import { migrations } from "../db/migrations/index.js";
import { runAdminCli } from "./admin.js";

/** The default database path for the admin CLI. */
export const DEFAULT_DATABASE_PATH = "/var/lib/wickmail/wickmail.db";

/** The default mail-store root for the admin CLI. */
export const DEFAULT_MAIL_STORE_DIRECTORY = "/var/vmail";

/**
 * Run the local admin CLI as a process. The database path comes from
 * `WICKMAIL_DB` and defaults to the packaged location. Bootstrap and recovery
 * run only with local access to the host and the database file.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const path = process.env.WICKMAIL_DB ?? DEFAULT_DATABASE_PATH;
  const mailStoreDirectory = process.env.WICKMAIL_MAIL_DIR ?? DEFAULT_MAIL_STORE_DIRECTORY;
  const db = openDatabase({ path });
  try {
    migrate(db, migrations);
    return await runAdminCli(
      argv,
      { db, mailStoreDirectory },
      {
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
      },
    );
  } finally {
    db.close();
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
