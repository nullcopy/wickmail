import { afterEach, describe, expect, it } from "vitest";
import { createSetupToken } from "../src/auth/setup.js";
import { createUser, setPasswordHash } from "../src/auth/users.js";
import { createApiHarness, type ApiHarness } from "./api-helpers.js";
import { NOW } from "./helpers.js";

let harness: ApiHarness;

afterEach(async () => {
  await harness?.close();
});

async function setupUserWithToken(h: ApiHarness): Promise<string> {
  const user = createUser(h.db, { username: "admin", now: h.now() });
  setPasswordHash(h.db, user.id, "test-hash:old", h.now());
  return createSetupToken(h.db, { userId: user.id, now: h.now() });
}

describe("bootstrap over the API", () => {
  it("consumes a single-use setup token and returns recovery codes once", async () => {
    harness = await createApiHarness({ skipUser: true });
    const token = await setupUserWithToken(harness);

    const first = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/setup",
      payload: { token, password: "a very long management password" },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json() as { recoveryCodes: string[]; csrfToken: string };
    expect(body.recoveryCodes.length).toBeGreaterThan(0);
    expect(body.csrfToken.length).toBeGreaterThan(0);
    expect(String(first.headers["set-cookie"])).toContain("HttpOnly");

    const second = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/setup",
      payload: { token, password: "a very long management password" },
    });
    expect(second.statusCode).toBe(401);
  });
});

describe("login and sessions", () => {
  it("sets a Secure, HttpOnly, SameSite cookie and resolves the session", async () => {
    harness = await createApiHarness();
    const login = await harness.login();
    expect(login.setCookie).toContain("HttpOnly");
    expect(login.setCookie).toContain("Secure");
    expect(login.setCookie).toContain("SameSite=Lax");
    expect(login.setCookie).toContain("Path=/");

    const session = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: harness.cookie(login.sessionToken),
    });
    expect(session.statusCode).toBe(200);
    const body = session.json() as { user: { username: string }; csrfToken: string };
    expect(body.user.username).toBe("admin");
    expect(body.csrfToken).toBe(login.csrfToken);
  });

  it("rejects an unauthenticated session request", async () => {
    harness = await createApiHarness();
    const response = await harness.app.inject({ method: "GET", url: "/v1/auth/session" });
    expect(response.statusCode).toBe(401);
  });

  it("revokes the session on logout", async () => {
    harness = await createApiHarness();
    const login = await harness.login();
    const logout = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { ...harness.cookie(login.sessionToken), "x-csrf-token": login.csrfToken },
    });
    expect(logout.statusCode).toBe(204);
    const after = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: harness.cookie(login.sessionToken),
    });
    expect(after.statusCode).toBe(401);
  });

  it("lists and revokes sessions by ID", async () => {
    harness = await createApiHarness();
    const first = await harness.login();
    const second = await harness.login();

    const list = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: harness.cookie(first.sessionToken),
    });
    expect(list.statusCode).toBe(200);
    const sessions = (list.json() as { sessions: Array<{ id: string; current: boolean }> })
      .sessions;
    expect(sessions.length).toBe(2);
    expect(sessions.filter((session) => session.current).length).toBe(1);

    const other = sessions.find((session) => !session.current)!;
    const revoke = await harness.app.inject({
      method: "DELETE",
      url: `/v1/auth/sessions/${other.id}`,
      headers: { ...harness.cookie(first.sessionToken), "x-csrf-token": first.csrfToken },
    });
    expect(revoke.statusCode).toBe(204);

    const revoked = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: harness.cookie(second.sessionToken),
    });
    expect(revoked.statusCode).toBe(401);
  });
});

describe("CSRF protection", () => {
  it("requires a CSRF token for cookie-authenticated mutations", async () => {
    harness = await createApiHarness();
    const login = await harness.login();

    const without = await harness.app.inject({
      method: "POST",
      url: "/v1/aliases",
      headers: harness.cookie(login.sessionToken),
      payload: { label: "No CSRF" },
    });
    expect(without.statusCode).toBe(403);
    expect((without.json() as { error: { code: string } }).error.code).toBe("csrf_failed");

    const wrong = await harness.app.inject({
      method: "POST",
      url: "/v1/aliases",
      headers: { ...harness.cookie(login.sessionToken), "x-csrf-token": "nope" },
      payload: { label: "Wrong CSRF" },
    });
    expect(wrong.statusCode).toBe(403);

    const withCsrf = await harness.app.inject({
      method: "POST",
      url: "/v1/aliases",
      headers: { ...harness.cookie(login.sessionToken), "x-csrf-token": login.csrfToken },
      payload: { label: "With CSRF" },
    });
    expect(withCsrf.statusCode).toBe(201);
  });
});

describe("password change and recovery", () => {
  it("changes the password and revokes other sessions", async () => {
    harness = await createApiHarness();
    const first = await harness.login();
    const second = await harness.login();

    const wrong = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/password",
      headers: { ...harness.cookie(first.sessionToken), "x-csrf-token": first.csrfToken },
      payload: { currentPassword: "not it", newPassword: "another long password" },
    });
    expect(wrong.statusCode).toBe(403);

    const changed = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/password",
      headers: { ...harness.cookie(first.sessionToken), "x-csrf-token": first.csrfToken },
      payload: { currentPassword: harness.password, newPassword: "another long password" },
    });
    expect(changed.statusCode).toBe(204);

    const stillCurrent = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: harness.cookie(first.sessionToken),
    });
    expect(stillCurrent.statusCode).toBe(200);

    const revoked = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: harness.cookie(second.sessionToken),
    });
    expect(revoked.statusCode).toBe(401);
  });

  it("recovers an account with a one-time recovery code", async () => {
    harness = await createApiHarness();
    const login = await harness.login();
    const regenerated = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/recovery-codes",
      headers: { ...harness.cookie(login.sessionToken), "x-csrf-token": login.csrfToken },
    });
    expect(regenerated.statusCode).toBe(200);
    const code = (regenerated.json() as { codes: string[] }).codes[0]!;

    const recover = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/recover",
      payload: { code, newPassword: "recovered long password" },
    });
    expect(recover.statusCode).toBe(200);
    const body = recover.json() as { recoveryCodes: string[] };
    expect(body.recoveryCodes.length).toBeGreaterThan(0);

    const reuse = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/recover",
      payload: { code, newPassword: "recovered long password" },
    });
    expect(reuse.statusCode).toBe(401);
  });
});
