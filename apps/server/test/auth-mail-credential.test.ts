import { afterEach, describe, expect, it } from "vitest";
import { getActiveMailCredential, verifyMailCredential } from "../src/auth/mailCredential.js";
import { createApiHarness, fastPasswordHasher, type ApiHarness } from "./api-helpers.js";

let harness: ApiHarness;

afterEach(async () => {
  await harness?.close();
});

describe("separate mail credential", () => {
  it("rotates and verifies independently of the management password", async () => {
    harness = await createApiHarness();
    const login = await harness.login();
    const rotate = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/mail-credential",
      headers: { ...harness.cookie(login.sessionToken), "x-csrf-token": login.csrfToken },
      payload: { password: "a separate mail password" },
    });
    expect(rotate.statusCode).toBe(201);

    const credential = getActiveMailCredential(harness.db, harness.user!.id);
    expect(credential).toBeDefined();
    const stored = harness.db
      .prepare("SELECT password_hash AS hash FROM mail_credentials WHERE id = ?")
      .get(credential!.id) as { hash: string };
    expect(stored.hash).not.toBe(harness.user!.passwordHash);
    expect(
      await verifyMailCredential(
        harness.db,
        harness.user!.id,
        "a separate mail password",
        fastPasswordHasher(),
      ),
    ).toBe(true);
    expect(
      await verifyMailCredential(harness.db, harness.user!.id, "wrong", fastPasswordHasher()),
    ).toBe(false);

    // The management credential is untouched.
    const relogin = await harness.login();
    expect(relogin.sessionToken.length).toBeGreaterThan(0);
  });

  it("revokes the mail credential without ending management sessions", async () => {
    harness = await createApiHarness();
    const login = await harness.login();
    await harness.app.inject({
      method: "POST",
      url: "/v1/auth/mail-credential",
      headers: { ...harness.cookie(login.sessionToken), "x-csrf-token": login.csrfToken },
      payload: { password: "a separate mail password" },
    });

    const revoke = await harness.app.inject({
      method: "DELETE",
      url: "/v1/auth/mail-credential",
      headers: { ...harness.cookie(login.sessionToken), "x-csrf-token": login.csrfToken },
    });
    expect(revoke.statusCode).toBe(204);
    expect(getActiveMailCredential(harness.db, harness.user!.id)).toBeUndefined();

    const session = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: harness.cookie(login.sessionToken),
    });
    expect(session.statusCode).toBe(200);

    const get = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/mail-credential",
      headers: harness.cookie(login.sessionToken),
    });
    expect((get.json() as { credential: unknown }).credential).toBeNull();
  });

  it("reports passkeys as not configured when WebAuthn is absent", async () => {
    harness = await createApiHarness();
    const login = await harness.login();
    const options = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/passkeys/registration/options",
      headers: { ...harness.cookie(login.sessionToken), "x-csrf-token": login.csrfToken },
    });
    expect(options.statusCode).toBe(501);
  });
});
