import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiClient } from "./api.ts";
import { ApiError } from "./errors.ts";
import { makeAlias, makeMessage, makeReplyContext } from "./testing.ts";

interface Call {
  url: string;
  init?: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingClient(handler: (call: Call) => Response): {
  client: ApiClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client = new ApiClient({
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return handler(call);
    },
  });
  return { client, calls };
}

test("listAliases builds a query and validates the response", async () => {
  const { client, calls } = recordingClient(() => jsonResponse({ items: [], nextCursor: null }));
  const result = await client.listAliases({ limit: 5, states: ["active", "expired"] });
  assert.deepEqual(result, { items: [], nextCursor: null });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^\/v1\/aliases\?/);
  assert.match(calls[0].url, /limit=5/);
  assert.match(calls[0].url, /state=active%2Cexpired/);
});

test("cookie mutations echo the CSRF token", async () => {
  const { client, calls } = recordingClient(() => jsonResponse(makeAlias(), 201));
  client.csrfToken = "csrf-123";
  await client.createAlias({ label: null, purpose: null, expiry: null, renewOnOutbound: null });
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("x-csrf-token"), "csrf-123");
  assert.equal(headers.get("content-type"), "application/json");
});

test("token mode sends a bearer header and no CSRF token", async () => {
  const { client, calls } = recordingClient(() => jsonResponse(makeAlias(), 201));
  client.bearerToken = "wmk_abc_secret";
  await client.createAlias({ label: null, purpose: null, expiry: null, renewOnOutbound: null });
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("authorization"), "Bearer wmk_abc_secret");
  assert.equal(headers.get("x-csrf-token"), null);
});

test("server error envelopes become ApiError", async () => {
  const { client } = recordingClient(() =>
    jsonResponse({ code: "alias_not_found", message: "alias not found" }, 404),
  );
  await assert.rejects(
    () => client.getAlias("missing"),
    (error: unknown) =>
      error instanceof ApiError && error.code === "alias_not_found" && error.status === 404,
  );
});

test("contract mismatches are reported distinctly", async () => {
  const { client } = recordingClient(() => jsonResponse({ unexpected: true }));
  await assert.rejects(
    () => client.listAliases(),
    (error: unknown) => error instanceof ApiError && error.code === "contract_mismatch",
  );
});

test("network failures surface as offline errors", async () => {
  const client = new ApiClient({
    fetch: async () => {
      throw new TypeError("failed to fetch");
    },
  });
  await assert.rejects(
    () => client.getVersion(),
    (error: unknown) => error instanceof ApiError && error.isOffline && error.code === "network",
  );
});

test("logout tolerates an empty 204 response", async () => {
  const { client } = recordingClient(() => new Response(null, { status: 204 }));
  await client.logout();
});

test("unauthorized responses notify the session", async () => {
  const { client } = recordingClient(() =>
    jsonResponse({ code: "unauthorized", message: "nope" }, 401),
  );
  let notified = false;
  client.onUnauthorized = () => {
    notified = true;
  };
  await assert.rejects(() => client.listAliases());
  assert.equal(notified, true);
});

test("message and reply payloads validate", async () => {
  const message = makeMessage();
  const context = makeReplyContext();
  const { client } = recordingClient((call) =>
    call.url.includes("reply-context")
      ? jsonResponse(context)
      : jsonResponse({ items: [message], nextCursor: null }),
  );
  const list = await client.listMessages({ limit: 10 });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].messageId, message.messageId);
  const loaded = await client.getReplyContext(message.messageId);
  assert.equal(loaded.identity.selection, "default");
});
