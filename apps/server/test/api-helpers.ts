import type { FastifyInstance } from "fastify";
import { buildApi } from "../src/api/app.js";
import type { AlertSink } from "../src/abuse/disk.js";
import { defaultAbuseLimits, type AbuseLimits } from "../src/abuse/limits.js";
import { SlidingWindowRateLimiter } from "../src/abuse/rateLimit.js";
import type { PasskeyConfig } from "../src/auth/passkeys.js";
import type { PasswordHasher } from "../src/auth/password.js";
import { createUser, setPasswordHash, type UserRow } from "../src/auth/users.js";
import type { SqliteDatabase } from "../src/db/database.js";
import { FakeMailStore } from "../src/mailstore/fake.js";
import { QuarantineService } from "../src/quarantine/service.js";
import { ReplyClient } from "../src/reply/client.js";
import { MemoryOutboundQueue } from "../src/reply/queue.js";
import { createTestDatabase, NOW } from "./helpers.js";

/** The password used by the API test harness. */
export const TEST_PASSWORD = "correct horse battery staple";

/** The username used by the API test harness. */
export const TEST_USERNAME = "admin";

/**
 * A deterministic, fast password hasher for API tests. It is deliberately not
 * Argon2id so that the many authentication-flow tests stay fast; a dedicated
 * test pins the production Argon2id hasher.
 */
export function fastPasswordHasher(): PasswordHasher {
  return {
    async hash(password: string): Promise<string> {
      return `test-hash:${password}`;
    },
    async verify(hash: string, password: string): Promise<boolean> {
      return hash === `test-hash:${password}`;
    },
  };
}

/** Options for {@link createApiHarness}. */
export interface HarnessOptions {
  /** Override the abuse limits. */
  limits?: AbuseLimits;
  /** WebAuthn configuration; passkeys are disabled when omitted. */
  passkeys?: PasskeyConfig;
  /** Whether session cookies set `Secure`. Defaults to true. */
  secureCookies?: boolean;
  /** The session cookie `SameSite` policy. */
  sameSite?: "lax" | "strict" | "none";
  /** Skip creating the initial user. */
  skipUser?: boolean;
  /** An alert sink to inspect. */
  alerts?: AlertSink;
}

/** A composed test harness around the management API. */
export interface ApiHarness {
  app: FastifyInstance;
  db: SqliteDatabase;
  mailStore: FakeMailStore;
  quarantine: QuarantineService;
  replyClient: ReplyClient;
  limits: AbuseLimits;
  user: UserRow | undefined;
  password: string;
  /** Advance or set the harness clock. */
  setNow(value: number): void;
  /** The current harness clock. */
  now(): number;
  /** Log in and return the session cookie and CSRF token. */
  login(): Promise<LoginResult>;
  /** Build a cookie header for a session token. */
  cookie(token: string): Record<string, string>;
  close(): Promise<void>;
}

/** The result of a successful login. */
export interface LoginResult {
  sessionToken: string;
  csrfToken: string;
  setCookie: string;
  body: Record<string, unknown>;
}

/** Parse the session cookie value out of a `set-cookie` header. */
export function sessionCookieValue(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (header === undefined) {
    return "";
  }
  const match = /wickmail_session=([^;]+)/.exec(header);
  return match?.[1] ?? "";
}

/** Build the API test harness. */
export async function createApiHarness(options: HarnessOptions = {}): Promise<ApiHarness> {
  const db = createTestDatabase();
  const mailStore = new FakeMailStore();
  const limits = options.limits ?? defaultAbuseLimits();
  let clock = NOW;
  const now = (): number => clock;

  const quarantine = new QuarantineService({ db, store: mailStore, now });
  const replyClient = new ReplyClient({
    db,
    mailStore,
    queue: new MemoryOutboundQueue(),
    primaryAddress: "me@example.com",
    now,
  });

  let user: UserRow | undefined;
  if (options.skipUser !== true) {
    user = createUser(db, { username: TEST_USERNAME, now: clock });
    user = setPasswordHash(db, user.id, `test-hash:${TEST_PASSWORD}`, clock);
  }

  const app = await buildApi({
    db,
    mailStore,
    quarantine,
    replyClient,
    config: {
      domain: "example.com",
      primaryAddress: "me@example.com",
      secureCookies: options.secureCookies ?? true,
      sameSite: options.sameSite ?? "lax",
      limits,
      ...(options.passkeys !== undefined ? { passkeys: options.passkeys } : {}),
    },
    now,
    passwordHasher: fastPasswordHasher(),
    rateLimiter: new SlidingWindowRateLimiter({ now }),
    ...(options.alerts !== undefined ? { alerts: options.alerts } : {}),
  });

  return {
    app,
    db,
    mailStore,
    quarantine,
    replyClient,
    limits,
    user,
    password: TEST_PASSWORD,
    setNow: (value: number): void => {
      clock = value;
    },
    now: (): number => clock,
    async login(): Promise<LoginResult> {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
      });
      const body = response.json() as Record<string, unknown>;
      const setCookie = response.headers["set-cookie"] as string | string[] | undefined;
      return {
        sessionToken: sessionCookieValue(setCookie),
        csrfToken: typeof body.csrfToken === "string" ? body.csrfToken : "",
        setCookie: Array.isArray(setCookie) ? (setCookie[0] ?? "") : (setCookie ?? ""),
        body,
      };
    },
    cookie(token: string): Record<string, string> {
      return { cookie: `wickmail_session=${token}` };
    },
    async close(): Promise<void> {
      quarantine.stop();
      await app.close();
      db.close();
    },
  };
}
