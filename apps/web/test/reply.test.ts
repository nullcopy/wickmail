import { describe, expect, it } from "vitest";
import { ApiClientError, type ReplyIdentityDecision } from "wickmail-core";
import {
  aliasIdForIdentity,
  classifyReplyFailure,
  defaultIdentity,
  identityKey,
  identityLabel,
  quoteOriginal,
  replySubject,
  requiresIdentityChoice,
} from "../src/lib/reply.js";

const aliasA = { kind: "alias", aliasId: "a", address: "green.farm@example.com" } as const;
const aliasB = { kind: "alias", aliasId: "b", address: "blue.sky@example.com" } as const;
const primary = { kind: "primary", address: "me@example.com" } as const;

describe("identity helpers", () => {
  it("builds stable keys and labels", () => {
    expect(identityKey(aliasA)).toBe("alias:a");
    expect(identityKey(primary)).toBe("primary:me@example.com");
    expect(identityLabel(aliasA)).toBe("green.farm@example.com");
    expect(identityLabel(primary)).toBe("me@example.com (primary address)");
  });

  it("requires a choice only when the decision prompts", () => {
    const prompt: ReplyIdentityDecision = {
      selection: "prompt",
      selected: null,
      options: [aliasA, aliasB],
    };
    const single: ReplyIdentityDecision = {
      selection: "default",
      selected: aliasA,
      options: [aliasA, primary],
    };
    expect(requiresIdentityChoice(prompt)).toBe(true);
    expect(requiresIdentityChoice(single)).toBe(false);
    expect(defaultIdentity(single)).toEqual(aliasA);
    expect(defaultIdentity(prompt)).toBeNull();
  });

  it("maps the primary identity to a null aliasId", () => {
    expect(aliasIdForIdentity(aliasA)).toBe("a");
    expect(aliasIdForIdentity(primary)).toBeNull();
  });
});

describe("replySubject", () => {
  it("prefixes a reply and avoids doubling Re:", () => {
    expect(replySubject("Your order shipped")).toBe("Re: Your order shipped");
    expect(replySubject("Re: Your order shipped")).toBe("Re: Your order shipped");
    expect(replySubject(null)).toBe("");
  });
});

describe("quoteOriginal", () => {
  it("prefixes each line", () => {
    expect(quoteOriginal("hello\n\nworld")).toBe("> hello\n>\n> world");
    expect(quoteOriginal("")).toBe("");
  });
});

describe("classifyReplyFailure", () => {
  it("reports a transport failure as offline", () => {
    expect(classifyReplyFailure(new ApiClientError(0, "network_error", "failed")).kind).toBe(
      "offline",
    );
  });

  it("reports a 403 as a permission problem", () => {
    expect(classifyReplyFailure(new ApiClientError(403, "forbidden", "no")).kind).toBe(
      "permission",
    );
  });

  it("reports an identity rejection as an identity problem", () => {
    const error = new ApiClientError(
      409,
      "conflict",
      "selected alias did not receive this message",
    );
    expect(classifyReplyFailure(error).kind).toBe("identity");
  });

  it("reports a generic conflict as rejected", () => {
    const error = new ApiClientError(409, "conflict", "alias lease expired");
    expect(classifyReplyFailure(error).kind).toBe("rejected");
  });

  it("reports a temporary failure as rejected", () => {
    expect(
      classifyReplyFailure(new ApiClientError(503, "temporarily_unavailable", "busy")).kind,
    ).toBe("rejected");
  });
});
