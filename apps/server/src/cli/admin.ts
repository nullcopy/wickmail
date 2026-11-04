import type { ApiScope } from "wickmail-core";
import { apiScopeSchema } from "wickmail-core";
import { createApiToken, listApiTokens, revokeApiToken } from "../auth/apiTokens.js";
import { argon2idHasher, type PasswordHasher } from "../auth/password.js";
import { countUnusedRecoveryCodes, generateRecoveryCodes } from "../auth/recovery.js";
import { consumeSetupToken, createSetupToken } from "../auth/setup.js";
import {
  createUser,
  getSoleUser,
  hasAnyUser,
  setPasswordHash,
  updateUsername,
  type UserRow,
} from "../auth/users.js";
import { rotateMailCredential, revokeMailCredential } from "../auth/mailCredential.js";
import { randomToken } from "../auth/tokens.js";
import type { SqliteDatabase } from "../db/database.js";

/** Output sinks for the admin CLI. */
export interface AdminCliIo {
  out(line: string): void;
  err(line: string): void;
}

/** Dependencies for the admin CLI. */
export interface AdminCliDeps {
  db: SqliteDatabase;
  /** The time source. Defaults to `Date.now`. */
  now?: () => number;
  /** The password hasher. Defaults to Argon2id. */
  passwordHasher?: PasswordHasher;
  /** The default username used by `bootstrap`. */
  defaultUsername?: string;
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      flags.set(name, "");
    } else {
      flags.set(name, value);
      index += 1;
    }
  }
  return { positionals, flags };
}

const USAGE = [
  "usage:",
  "  bootstrap [--username <name>]",
  "  setup --token <token> --password <password> [--username <name>]",
  "  password --password <password>",
  "  recovery-codes",
  "  mail-password [--password <password>]",
  "  revoke-mail-credential",
  "  token create --name <name> --scopes <scope,scope> [--expires-in-days <n>]",
  "  token list",
  "  token revoke --id <id>",
  "  user",
].join("\n");

function requireUser(deps: AdminCliDeps, io: AdminCliIo): UserRow | undefined {
  const user = getSoleUser(deps.db);
  if (user === undefined) {
    io.err("no user is configured; run `bootstrap` first");
    return undefined;
  }
  return user;
}

function parseScopes(value: string | undefined): ApiScope[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  const scopes: ApiScope[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const parsed = apiScopeSchema.safeParse(trimmed);
    if (!parsed.success) {
      throw new Error(`unknown scope: ${trimmed}`);
    }
    scopes.push(parsed.data);
  }
  return scopes;
}

/**
 * Run a local administrative command.
 *
 * Bootstrap and recovery run only with local access to the host and the
 * database file; they never depend on email and there are no default
 * credentials. The setup token and API token secrets are printed once and only
 * their hashes are stored.
 */
export async function runAdminCli(
  argv: readonly string[],
  deps: AdminCliDeps,
  io: AdminCliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  const { positionals, flags } = parseArgs(rest);
  const at = (deps.now ?? Date.now)();
  const hasher = deps.passwordHasher ?? argon2idHasher;

  try {
    switch (command) {
      case "bootstrap": {
        if (hasAnyUser(deps.db)) {
          io.err("a user already exists; bootstrap runs only on first run");
          return 1;
        }
        const username = flags.get("username") || deps.defaultUsername || "admin";
        const user = createUser(deps.db, { username, now: at });
        const token = createSetupToken(deps.db, { userId: user.id, now: at });
        io.out(`created user: ${user.username}`);
        io.out("single-use setup token (shown once):");
        io.out(token);
        io.out("complete setup with: setup --token <token> --password <password>");
        return 0;
      }

      case "setup": {
        const token = flags.get("token");
        const password = flags.get("password");
        if (token === undefined || token.length === 0 || password === undefined) {
          io.err(USAGE);
          return 2;
        }
        const consumed = consumeSetupToken(deps.db, token, at);
        if (consumed === undefined) {
          io.err("setup token is invalid, expired, or already used");
          return 1;
        }
        if (flags.has("username")) {
          updateUsername(deps.db, consumed.userId, flags.get("username") ?? "", at);
        }
        const passwordHash = await hasher.hash(password);
        setPasswordHash(deps.db, consumed.userId, passwordHash, at);
        const codes = generateRecoveryCodes(deps.db, { userId: consumed.userId, now: at });
        io.out("management password set");
        io.out("recovery codes (shown once):");
        for (const code of codes) {
          io.out(code);
        }
        return 0;
      }

      case "password": {
        const password = flags.get("password");
        if (password === undefined || password.length === 0) {
          io.err(USAGE);
          return 2;
        }
        const user = requireUser(deps, io);
        if (user === undefined) return 1;
        const passwordHash = await hasher.hash(password);
        setPasswordHash(deps.db, user.id, passwordHash, at);
        io.out("management password reset");
        return 0;
      }

      case "recovery-codes": {
        const user = requireUser(deps, io);
        if (user === undefined) return 1;
        const codes = generateRecoveryCodes(deps.db, { userId: user.id, now: at });
        io.out("recovery codes (shown once):");
        for (const code of codes) {
          io.out(code);
        }
        return 0;
      }

      case "mail-password": {
        const user = requireUser(deps, io);
        if (user === undefined) return 1;
        const provided = flags.get("password");
        const password = provided !== undefined && provided.length > 0 ? provided : randomToken(18);
        const passwordHash = await hasher.hash(password);
        rotateMailCredential(deps.db, { userId: user.id, passwordHash, now: at });
        io.out("mail credential rotated");
        if (provided === undefined || provided.length === 0) {
          io.out(`generated mail password (shown once): ${password}`);
        }
        return 0;
      }

      case "revoke-mail-credential": {
        const user = requireUser(deps, io);
        if (user === undefined) return 1;
        const revoked = revokeMailCredential(deps.db, user.id, at);
        io.out(`revoked ${revoked} mail credential(s)`);
        return 0;
      }

      case "token": {
        const subcommand = positionals[0];
        const user = requireUser(deps, io);
        if (user === undefined) return 1;
        if (subcommand === "create") {
          const name = flags.get("name");
          const scopes = parseScopes(flags.get("scopes"));
          if (name === undefined || name.length === 0 || scopes.length === 0) {
            io.err("token create requires --name and --scopes");
            return 2;
          }
          const days = flags.get("expires-in-days");
          const expiresAt =
            days !== undefined && days.length > 0 ? at + Number(days) * 24 * 60 * 60 * 1000 : null;
          const created = createApiToken(deps.db, {
            userId: user.id,
            name,
            scopes,
            now: at,
            expiresAt,
          });
          io.out("API token created; secret is shown once:");
          io.out(created.secret);
          return 0;
        }
        if (subcommand === "list") {
          for (const token of listApiTokens(deps.db)) {
            io.out(`${token.id}  ${token.name}  [${token.scopes.join(",")}]`);
          }
          return 0;
        }
        if (subcommand === "revoke") {
          const id = flags.get("id");
          if (id === undefined || id.length === 0) {
            io.err("token revoke requires --id");
            return 2;
          }
          const revoked = revokeApiToken(deps.db, id, at);
          io.out(revoked ? "token revoked" : "token not found or already revoked");
          return revoked ? 0 : 1;
        }
        io.err(USAGE);
        return 2;
      }

      case "user": {
        const user = requireUser(deps, io);
        if (user === undefined) return 1;
        io.out(`username: ${user.username}`);
        io.out(`password set: ${user.passwordHash !== null}`);
        io.out(`recovery codes remaining: ${countUnusedRecoveryCodes(deps.db, user.id)}`);
        return 0;
      }

      default:
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
