import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

/**
 * The numeric identifier for Argon2id in `@node-rs/argon2`. The package exports
 * it as an ambient const enum, which `verbatimModuleSyntax` forbids importing,
 * so the stable numeric value is used directly.
 */
const ARGON2ID = 2;

/**
 * A password hashing strategy. Production uses Argon2id; tests may inject a
 * cheaper implementation so that authentication-flow tests stay fast, while a
 * dedicated test pins the production hasher's algorithm.
 */
export interface PasswordHasher {
  /** Hash a password for storage. */
  hash(password: string): Promise<string>;
  /** Verify a password against a stored hash. */
  verify(hash: string, password: string): Promise<boolean>;
}

/** Argon2id parameters. They follow the OWASP minimum recommendation. */
export interface Argon2idOptions {
  /** Memory cost in KiB. Defaults to 19456 (19 MiB). */
  memoryCost?: number;
  /** Iterations. Defaults to 2. */
  timeCost?: number;
  /** Lanes. Defaults to 1. */
  parallelism?: number;
  /** Output length in bytes. Defaults to 32. */
  outputLen?: number;
}

/**
 * Build an Argon2id password hasher. Passwords are salted by the library and
 * the stored hash is a standard PHC string, so it is portable.
 */
export function createArgon2idHasher(options: Argon2idOptions = {}): PasswordHasher {
  const parameters = {
    algorithm: ARGON2ID,
    memoryCost: options.memoryCost ?? 19456,
    timeCost: options.timeCost ?? 2,
    parallelism: options.parallelism ?? 1,
    outputLen: options.outputLen ?? 32,
  };

  return {
    hash: (password) => argon2Hash(password, parameters),
    verify: async (hash, password) => {
      try {
        return await argon2Verify(hash, password, parameters);
      } catch {
        return false;
      }
    },
  };
}

/** The production password hasher: Argon2id with the OWASP minimum parameters. */
export const argon2idHasher: PasswordHasher = createArgon2idHasher();

/** Whether a stored hash was produced with Argon2id. */
export function isArgon2idHash(hash: string): boolean {
  return hash.startsWith("$argon2id$");
}
