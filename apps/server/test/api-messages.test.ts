import { afterEach, describe, expect, it } from "vitest";
import { recordInboundAcceptance } from "../src/provenance/repository.js";
import { createApiHarness, type ApiHarness } from "./api-helpers.js";
import { DAY_MS, NOW } from "./helpers.js";
import { createTestAlias } from "./mail-helpers.js";

let harness: ApiHarness;

afterEach(async () => {
  await harness?.close();
});

const MESSAGE_ID = "018f0d9c-0000-7000-8000-0000000000ff";

function seedMessage(h: ApiHarness, aliasId: string, raw: string): void {
  recordInboundAcceptance(h.db, {
    messageId: MESSAGE_ID,
    aliasIds: [aliasId],
    primaryReceived: false,
    envelopeRecipients: ["green.farm@example.com"],
    createdAt: NOW,
  });
  h.mailStore.put("Inbox", MESSAGE_ID, raw, NOW);
}

async function session(h: ApiHarness): Promise<{ cookie: Record<string, string>; csrf: string }> {
  const login = await h.login();
  return { cookie: h.cookie(login.sessionToken), csrf: login.csrfToken };
}

describe("message reply API", () => {
  it("returns sanitized reply context with trusted provenance", async () => {
    harness = await createApiHarness();
    const alias = createTestAlias(harness.db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
    });
    seedMessage(
      harness,
      alias.id,
      [
        "From: Sender <sender@example.net>",
        "Subject: Your order",
        "Message-ID: <orig-1@example.net>",
        "",
        "Thanks for your order.",
      ].join("\r\n"),
    );
    const s = await session(harness);

    const response = await harness.app.inject({
      method: "GET",
      url: `/v1/messages/${MESSAGE_ID}/reply-context`,
      headers: s.cookie,
    });
    expect(response.statusCode).toBe(200);
    const context = response.json() as {
      sender: string;
      subject: string;
      text: string;
      identity: { selected: { kind: string; aliasId: string } };
      provenance: { aliasIds: string[] };
    };
    expect(context.sender).toBe("sender@example.net");
    expect(context.subject).toBe("Your order");
    expect(context.text).toBe("Thanks for your order.");
    expect(context.identity.selected).toEqual({
      kind: "alias",
      aliasId: alias.id,
      address: "green.farm@example.com",
    });
    expect(context.provenance.aliasIds).toEqual([alias.id]);
  });

  it("returns 404 when a message has no trusted provenance", async () => {
    harness = await createApiHarness();
    harness.mailStore.put("Inbox", "unknown", "From: a@b.example\r\n\r\nbody", NOW);
    const s = await session(harness);
    const response = await harness.app.inject({
      method: "GET",
      url: "/v1/messages/unknown/reply-context",
      headers: s.cookie,
    });
    expect(response.statusCode).toBe(404);
  });

  it("queues a reply as the receiving alias and renews the lease", async () => {
    harness = await createApiHarness();
    const alias = createTestAlias(harness.db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
      leaseDurationSeconds: 3600,
    });
    seedMessage(harness, alias.id, "From: sender@example.net\r\nSubject: Hi\r\n\r\nbody");
    const s = await session(harness);

    const response = await harness.app.inject({
      method: "POST",
      url: `/v1/messages/${MESSAGE_ID}/reply`,
      headers: { ...s.cookie, "x-csrf-token": s.csrf },
      payload: { body: "My reply" },
    });
    expect(response.statusCode).toBe(200);
    const result = response.json() as {
      identity: { kind: string; aliasId: string };
      renewed: boolean;
      expiresAt: string;
    };
    expect(result.identity.kind).toBe("alias");
    expect(result.identity.aliasId).toBe(alias.id);
    expect(result.renewed).toBe(true);
    expect(result.expiresAt).toBe(new Date(NOW + 3600 * 1000).toISOString());
  });

  it("requires a CSRF token for a cookie reply", async () => {
    harness = await createApiHarness();
    const alias = createTestAlias(harness.db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
    });
    seedMessage(harness, alias.id, "From: sender@example.net\r\nSubject: Hi\r\n\r\nbody");
    const s = await session(harness);

    const response = await harness.app.inject({
      method: "POST",
      url: `/v1/messages/${MESSAGE_ID}/reply`,
      headers: s.cookie,
      payload: { body: "My reply" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("enforces message scopes", async () => {
    harness = await createApiHarness();
    const alias = createTestAlias(harness.db, {
      address: "green.farm@example.com",
      expiresAt: NOW + DAY_MS,
    });
    seedMessage(harness, alias.id, "From: sender@example.net\r\nSubject: Hi\r\n\r\nbody");
    const s = await session(harness);

    const token = await harness.app.inject({
      method: "POST",
      url: "/v1/auth/tokens",
      headers: { ...s.cookie, "x-csrf-token": s.csrf },
      payload: { name: "m-read", scopes: ["messages:read"] },
    });
    const secret = (token.json() as { secret: string }).secret;

    const context = await harness.app.inject({
      method: "GET",
      url: `/v1/messages/${MESSAGE_ID}/reply-context`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(context.statusCode).toBe(200);

    const reply = await harness.app.inject({
      method: "POST",
      url: `/v1/messages/${MESSAGE_ID}/reply`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { body: "not allowed" },
    });
    expect(reply.statusCode).toBe(403);
  });
});
