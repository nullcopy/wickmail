import { describe, expect, it } from "vitest";
import {
  replyContextValidator,
  replyIdentityDecisionValidator,
  replyRequestValidator,
  replyResultValidator,
} from "./index.js";

const ALIAS_ID = "018f0d9c-0000-7000-8000-00000000000a";
const MESSAGE_ID = "018f0d9c-0000-7000-8000-0000000000ff";

describe("replyRequestSchema", () => {
  it("accepts an alias, body, and quoted text", () => {
    expect(
      replyRequestValidator.safeParse({ aliasId: ALIAS_ID, body: "hi", quotedText: "> old" })
        .success,
    ).toBe(true);
  });

  it("accepts a null alias for the primary identity", () => {
    expect(replyRequestValidator.safeParse({ aliasId: null, body: "hi" }).success).toBe(true);
  });

  it("rejects unknown fields and a missing body", () => {
    expect(replyRequestValidator.safeParse({ body: "hi", address: "x@y.example" }).success).toBe(
      false,
    );
    expect(replyRequestValidator.safeParse({ aliasId: ALIAS_ID }).success).toBe(false);
  });
});

describe("replyIdentityDecisionSchema", () => {
  it("accepts a default alias selection with a primary alternative", () => {
    const result = replyIdentityDecisionValidator.safeParse({
      selection: "default",
      selected: { kind: "alias", aliasId: ALIAS_ID, address: "green.farm@example.com" },
      options: [
        { kind: "alias", aliasId: ALIAS_ID, address: "green.farm@example.com" },
        { kind: "primary", address: "me@example.com" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a prompt with no selection", () => {
    const result = replyIdentityDecisionValidator.safeParse({
      selection: "prompt",
      selected: null,
      options: [{ kind: "primary", address: "me@example.com" }],
    });
    expect(result.success).toBe(true);
  });
});

describe("replyContextSchema", () => {
  it("accepts sanitized context with provenance", () => {
    const result = replyContextValidator.safeParse({
      messageId: MESSAGE_ID,
      sender: "sender@example.net",
      subject: "Hello",
      text: "body",
      originalMessageId: "<orig@example.net>",
      provenance: {
        messageId: MESSAGE_ID,
        aliasIds: [ALIAS_ID],
        primaryReceived: false,
        envelopeRecipients: ["green.farm@example.com"],
      },
      identity: {
        selection: "default",
        selected: { kind: "alias", aliasId: ALIAS_ID, address: "green.farm@example.com" },
        options: [{ kind: "alias", aliasId: ALIAS_ID, address: "green.farm@example.com" }],
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("replyResultSchema", () => {
  it("accepts a queued result", () => {
    const result = replyResultValidator.safeParse({
      messageId: MESSAGE_ID,
      identity: { kind: "alias", aliasId: ALIAS_ID, address: "green.farm@example.com" },
      renewed: true,
      expiresAt: "2026-11-04T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts no expiry", () => {
    const result = replyResultValidator.safeParse({
      messageId: MESSAGE_ID,
      identity: { kind: "primary", address: "me@example.com" },
      renewed: false,
      expiresAt: null,
    });
    expect(result.success).toBe(true);
  });
});
