import { afterEach, describe, expect, it } from "vitest";
import { getAliasById } from "../src/alias/repository.js";
import { createUser } from "../src/auth/users.js";
import { createApiHarness, type ApiHarness } from "./api-helpers.js";
import { DAY_MS, NOW } from "./helpers.js";
import { createTestAlias } from "./mail-helpers.js";
import { seedQuarantinedMessage } from "./quarantine-helpers.js";

let harness: ApiHarness;

afterEach(async () => {
  await harness?.close();
});

async function session(h: ApiHarness): Promise<{ cookie: Record<string, string>; csrf: string }> {
  const login = await h.login();
  return { cookie: h.cookie(login.sessionToken), csrf: login.csrfToken };
}

function mutateHeaders(s: { cookie: Record<string, string>; csrf: string }) {
  return { ...s.cookie, "x-csrf-token": s.csrf };
}

describe("quarantine API", () => {
  it("lists and gets quarantined messages", async () => {
    harness = await createApiHarness();
    const alias = createTestAlias(harness.db, {
      address: "green.farm@example.com",
      expiresAt: NOW - DAY_MS,
    });
    seedQuarantinedMessage(harness.db, harness.mailStore, {
      messageId: "msg-1",
      aliasIds: [alias.id],
      subject: "Old order",
      receivedAt: NOW - 2000,
    });
    seedQuarantinedMessage(harness.db, harness.mailStore, {
      messageId: "msg-2",
      aliasIds: [alias.id],
      subject: "Older order",
      receivedAt: NOW - 1000,
    });
    const s = await session(harness);

    const list = await harness.app.inject({
      method: "GET",
      url: "/v1/quarantine?status=quarantined&sort=received&order=asc",
      headers: s.cookie,
    });
    expect(list.statusCode).toBe(200);
    const messages = (list.json() as { messages: Array<{ messageId: string }> }).messages;
    expect(messages.map((message) => message.messageId)).toEqual(["msg-1", "msg-2"]);

    const get = await harness.app.inject({
      method: "GET",
      url: "/v1/quarantine/msg-1",
      headers: s.cookie,
    });
    expect(get.statusCode).toBe(200);
    expect((get.json() as { message: { subject: string } }).message.subject).toBe("Old order");
  });

  it("recovers a quarantined message into the inbox", async () => {
    harness = await createApiHarness();
    const alias = createTestAlias(harness.db, {
      address: "green.farm@example.com",
      expiresAt: NOW - DAY_MS,
    });
    seedQuarantinedMessage(harness.db, harness.mailStore, {
      messageId: "msg-1",
      aliasIds: [alias.id],
    });
    const s = await session(harness);

    const recover = await harness.app.inject({
      method: "POST",
      url: "/v1/quarantine/msg-1/recover",
      headers: mutateHeaders(s),
      payload: {},
    });
    expect(recover.statusCode).toBe(200);
    expect((recover.json() as { status: string }).status).toBe("recovered");
    expect(await harness.mailStore.getMessageIn("Inbox", "msg-1")).toBeDefined();
    expect(await harness.mailStore.getMessageIn("Aliases/Expired", "msg-1")).toBeUndefined();
  });

  it("recovers and renews the alias", async () => {
    harness = await createApiHarness();
    const alias = createTestAlias(harness.db, {
      address: "green.farm@example.com",
      expiresAt: NOW - DAY_MS,
      leaseDurationSeconds: 3600,
    });
    seedQuarantinedMessage(harness.db, harness.mailStore, {
      messageId: "msg-1",
      aliasIds: [alias.id],
    });
    const s = await session(harness);

    const recover = await harness.app.inject({
      method: "POST",
      url: "/v1/quarantine/msg-1/recover",
      headers: mutateHeaders(s),
      payload: { renew: true },
    });
    expect(recover.statusCode).toBe(200);
    expect(getAliasById(harness.db, alias.id)!.expiresAt).toBe(NOW + 3600 * 1000);
  });

  it("deletes a quarantined message", async () => {
    harness = await createApiHarness();
    const alias = createTestAlias(harness.db, {
      address: "green.farm@example.com",
      expiresAt: NOW - DAY_MS,
    });
    seedQuarantinedMessage(harness.db, harness.mailStore, {
      messageId: "msg-1",
      aliasIds: [alias.id],
    });
    const s = await session(harness);

    const response = await harness.app.inject({
      method: "POST",
      url: "/v1/quarantine/msg-1/delete",
      headers: mutateHeaders(s),
      payload: { reason: "spam" },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { status: string }).status).toBe("deleted");
    expect(await harness.mailStore.getMessageIn("Aliases/Expired", "msg-1")).toBeUndefined();
  });

  it("hides a message whose alias is owned by another user", async () => {
    harness = await createApiHarness();
    const otherUser = createUser(harness.db, { username: "other", now: NOW });
    const other = createTestAlias(harness.db, { address: "other@example.com", expiresAt: null });
    harness.db.prepare("UPDATE aliases SET owner_id = ? WHERE id = ?").run(otherUser.id, other.id);
    seedQuarantinedMessage(harness.db, harness.mailStore, {
      messageId: "msg-1",
      aliasIds: [other.id],
    });
    const s = await session(harness);

    const response = await harness.app.inject({
      method: "GET",
      url: "/v1/quarantine/msg-1",
      headers: s.cookie,
    });
    expect(response.statusCode).toBe(404);
  });

  it("enforces quarantine scopes", async () => {
    harness = await createApiHarness();
    const alias = createTestAlias(harness.db, {
      address: "green.farm@example.com",
      expiresAt: NOW - DAY_MS,
    });
    seedQuarantinedMessage(harness.db, harness.mailStore, {
      messageId: "msg-1",
      aliasIds: [alias.id],
    });
    const s = await session(harness);

    const token = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/tokens",
      headers: mutateHeaders(s),
      payload: { name: "q-read", scopes: ["quarantine:read"] },
    });
    const secret = (token.json() as { secret: string }).secret;

    const list = await harness.app.inject({
      method: "GET",
      url: "/v1/quarantine",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(list.statusCode).toBe(200);

    const remove = await harness.app.inject({
      method: "POST",
      url: "/v1/quarantine/msg-1/delete",
      headers: { authorization: `Bearer ${secret}` },
      payload: {},
    });
    expect(remove.statusCode).toBe(403);
  });
});
