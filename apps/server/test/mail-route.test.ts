import { describe, expect, it } from "vitest";
import { chooseRoute } from "../src/mail/route.js";
import { isSpam } from "../src/mail/spam.js";

describe("chooseRoute", () => {
  it("routes spam to Spam regardless of alias state", () => {
    expect(chooseRoute({ spam: true, aliasStates: ["active"], primaryReceived: true })).toBe(
      "Spam",
    );
    expect(chooseRoute({ spam: true, aliasStates: ["expired"], primaryReceived: false })).toBe(
      "Spam",
    );
    expect(chooseRoute({ spam: true, aliasStates: [], primaryReceived: true })).toBe("Spam");
  });

  it("routes a message to an active alias to Inbox", () => {
    expect(chooseRoute({ spam: false, aliasStates: ["active"], primaryReceived: false })).toBe(
      "Inbox",
    );
  });

  it("routes a message only to expired or disabled aliases to Aliases/Expired", () => {
    expect(chooseRoute({ spam: false, aliasStates: ["expired"], primaryReceived: false })).toBe(
      "Aliases/Expired",
    );
    expect(chooseRoute({ spam: false, aliasStates: ["disabled"], primaryReceived: false })).toBe(
      "Aliases/Expired",
    );
    expect(
      chooseRoute({ spam: false, aliasStates: ["expired", "disabled"], primaryReceived: false }),
    ).toBe("Aliases/Expired");
  });

  it("delivers when at least one receiving alias is active", () => {
    expect(
      chooseRoute({ spam: false, aliasStates: ["expired", "active"], primaryReceived: false }),
    ).toBe("Inbox");
  });

  it("routes a primary-only message to Inbox", () => {
    expect(chooseRoute({ spam: false, aliasStates: [], primaryReceived: true })).toBe("Inbox");
  });
});

describe("isSpam", () => {
  it("reads the X-Spam-Flag header", () => {
    expect(isSpam("X-Spam-Flag: YES\r\n\r\nbody")).toBe(true);
    expect(isSpam("X-Spam-Flag: NO\r\n\r\nbody")).toBe(false);
  });

  it("reads the X-Spam-Status header", () => {
    expect(isSpam("X-Spam-Status: Yes, score=9.9\r\n\r\nbody")).toBe(true);
    expect(isSpam("X-Spam-Status: No, score=0.1\r\n\r\nbody")).toBe(false);
  });

  it("treats a message without spam headers as not spam", () => {
    expect(isSpam("From: a@b.example\r\n\r\nbody")).toBe(false);
  });
});
