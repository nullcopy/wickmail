import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "./errors.ts";
import {
  defaultIdentityKey,
  findIdentity,
  identityAlternatives,
  identityKey,
  identityLabel,
  identitySelection,
  replyErrorGuidance,
  replySubject,
  requiresIdentityChoice,
} from "./reply.ts";
import { makeReplyContext } from "./testing.ts";

test("replySubject prefixes without double-prefixing", () => {
  assert.equal(replySubject("Your order"), "Re: Your order");
  assert.equal(replySubject("Re: Your order"), "Re: Your order");
  assert.equal(replySubject(null), "Re:");
});

test("identity keys and labels distinguish aliases from primary", () => {
  const alias = {
    kind: "alias" as const,
    aliasId: "a1",
    address: "green.farm@example.com",
  };
  const primary = { kind: "primary" as const, address: "user@example.com" };
  assert.equal(identityKey(alias), "alias:a1");
  assert.equal(identityKey(primary), "primary");
  assert.equal(identityLabel(primary), "user@example.com (primary)");
  assert.deepEqual(identitySelection(alias), { aliasId: "a1", primary: null });
  assert.deepEqual(identitySelection(primary), { aliasId: null, primary: true });
  assert.deepEqual(identitySelection(null), { aliasId: null, primary: null });
});

test("a single alias defaults and offers the primary as an alternative", () => {
  const context = makeReplyContext();
  assert.equal(requiresIdentityChoice(context), false);
  assert.equal(defaultIdentityKey(context), "alias:018f9b60-0000-7000-8000-000000000001");
  assert.deepEqual(
    identityAlternatives(
      context,
      findIdentity(context, "alias:018f9b60-0000-7000-8000-000000000001"),
    ).map(identityKey),
    ["primary"],
  );
});

test("multiple aliases require an explicit choice", () => {
  const context = makeReplyContext({
    identity: {
      selection: "prompt",
      selected: null,
      options: [
        { kind: "alias", aliasId: "a1", address: "one@example.com" },
        { kind: "alias", aliasId: "a2", address: "two@example.com" },
      ],
    },
  });
  assert.equal(requiresIdentityChoice(context), true);
  assert.equal(defaultIdentityKey(context), null);
});

test("replyErrorGuidance names identity errors and offers alternatives", () => {
  const forbidden = replyErrorGuidance(new ApiError(403, "forbidden", "nope"), {
    kind: "alias",
    aliasId: "a1",
    address: "green.farm@example.com",
  });
  assert.match(forbidden.title, /Identity not allowed/);
  assert.match(forbidden.detail, /green\.farm@example\.com/);
  const required = replyErrorGuidance(new ApiError(409, "identity_required", "choose"));
  assert.match(required.detail, /Choose the alias/);
  const offline = replyErrorGuidance(new ApiError(0, "network", "down"));
  assert.match(offline.title, /not sent/);
});
