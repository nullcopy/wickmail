import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApiHarness, type ApiHarness } from "./api-helpers.js";

let harness: ApiHarness;

afterEach(async () => {
  await harness?.close();
});

const passkeyConfig = {
  rpID: "example.com",
  rpName: "Wickmail",
  origin: "https://example.com",
};

function countChallenges(h: ApiHarness, kind: string): number {
  const row = h.db
    .prepare("SELECT COUNT(*) AS count FROM auth_challenges WHERE kind = ?")
    .get(kind) as { count: number };
  return row.count;
}

describe("passkeys", () => {
  it("generates registration options and stores the challenge", async () => {
    harness = await createApiHarness({ passkeys: passkeyConfig });
    const login = await harness.login();
    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/passkeys/registration/options",
      headers: { ...harness.cookie(login.sessionToken), "x-csrf-token": login.csrfToken },
    });
    expect(response.statusCode).toBe(200);
    const options = (response.json() as { options: { challenge: string } }).options;
    expect(typeof options.challenge).toBe("string");
    expect(countChallenges(harness, "registration")).toBe(1);
  });

  it("rejects an unverifiable registration response", async () => {
    harness = await createApiHarness({ passkeys: passkeyConfig });
    const login = await harness.login();
    await harness.app.inject({
      method: "POST",
      url: "/v1/auth/passkeys/registration/options",
      headers: { ...harness.cookie(login.sessionToken), "x-csrf-token": login.csrfToken },
    });
    const verify = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/passkeys/registration/verify",
      headers: { ...harness.cookie(login.sessionToken), "x-csrf-token": login.csrfToken },
      payload: { response: { id: "x", type: "public-key" } },
    });
    expect(verify.statusCode).toBe(403);
  });

  it("generates authentication options and rejects an unverifiable response", async () => {
    harness = await createApiHarness({ passkeys: passkeyConfig });
    const options = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/passkeys/authentication/options",
    });
    expect(options.statusCode).toBe(200);
    expect(countChallenges(harness, "authentication")).toBe(1);

    const verify = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/passkeys/authentication/verify",
      payload: { response: { id: "missing", type: "public-key" } },
    });
    expect(verify.statusCode).toBe(401);
  });

  it("lists and deletes stored credentials", async () => {
    harness = await createApiHarness({ passkeys: passkeyConfig });
    const credentialId = randomUUID();
    harness.db
      .prepare(
        `INSERT INTO passkey_credentials
           (id, user_id, credential_id, public_key, counter, transports, name, created_at, last_used_at)
         VALUES (?, ?, ?, ?, 0, '[]', ?, ?, NULL)`,
      )
      .run(
        randomUUID(),
        harness.user!.id,
        credentialId,
        Buffer.from([1, 2, 3]),
        "YubiKey",
        harness.now(),
      );

    const login = await harness.login();
    const list = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/passkeys",
      headers: harness.cookie(login.sessionToken),
    });
    const passkeys = (list.json() as { passkeys: Array<{ id: string; name: string }> }).passkeys;
    expect(passkeys).toHaveLength(1);
    expect(passkeys[0]!.name).toBe("YubiKey");

    const remove = await harness.app.inject({
      method: "DELETE",
      url: `/v1/auth/passkeys/${passkeys[0]!.id}`,
      headers: { ...harness.cookie(login.sessionToken), "x-csrf-token": login.csrfToken },
    });
    expect(remove.statusCode).toBe(204);

    const after = await harness.app.inject({
      method: "GET",
      url: "/v1/auth/passkeys",
      headers: harness.cookie(login.sessionToken),
    });
    expect((after.json() as { passkeys: unknown[] }).passkeys).toHaveLength(0);
  });
});
