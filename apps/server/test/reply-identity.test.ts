import { describe, expect, it } from "vitest";
import { selectReplyIdentity } from "../src/reply/identity.js";

const PRIMARY = "me@example.com";
const ALIAS_A = "green.farm@example.com";
const ALIAS_B = "blue.sky@example.com";
const ID_A = "018f0d9c-0000-7000-8000-00000000000a";
const ID_B = "018f0d9c-0000-7000-8000-00000000000b";

function aliases(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries);
}

describe("selectReplyIdentity", () => {
  it("selects exactly one receiving alias by default and offers the primary", () => {
    const decision = selectReplyIdentity(
      { aliasIds: [ID_A], primaryReceived: false },
      aliases([[ID_A, ALIAS_A]]),
      PRIMARY,
    );
    expect(decision.selection).toBe("default");
    expect(decision.selected).toEqual({ kind: "alias", aliasId: ID_A, address: ALIAS_A });
    expect(decision.options).toEqual([
      { kind: "alias", aliasId: ID_A, address: ALIAS_A },
      { kind: "primary", address: PRIMARY },
    ]);
  });

  it("uses the primary identity for a primary-only message", () => {
    const decision = selectReplyIdentity(
      { aliasIds: [], primaryReceived: true },
      aliases([]),
      PRIMARY,
    );
    expect(decision.selection).toBe("default");
    expect(decision.selected).toEqual({ kind: "primary", address: PRIMARY });
    expect(decision.options).toEqual([{ kind: "primary", address: PRIMARY }]);
  });

  it("defaults to the alias when the primary and exactly one alias received it", () => {
    const decision = selectReplyIdentity(
      { aliasIds: [ID_A], primaryReceived: true },
      aliases([[ID_A, ALIAS_A]]),
      PRIMARY,
    );
    expect(decision.selection).toBe("default");
    expect(decision.selected).toEqual({ kind: "alias", aliasId: ID_A, address: ALIAS_A });
  });

  it("prompts and selects nothing when multiple aliases received it", () => {
    const decision = selectReplyIdentity(
      { aliasIds: [ID_A, ID_B], primaryReceived: true },
      aliases([
        [ID_A, ALIAS_A],
        [ID_B, ALIAS_B],
      ]),
      PRIMARY,
    );
    expect(decision.selection).toBe("prompt");
    expect(decision.selected).toBeNull();
    expect(decision.options).toEqual([
      { kind: "alias", aliasId: ID_A, address: ALIAS_A },
      { kind: "alias", aliasId: ID_B, address: ALIAS_B },
      { kind: "primary", address: PRIMARY },
    ]);
  });

  it("prompts when multiple aliases received it even without the primary", () => {
    const decision = selectReplyIdentity(
      { aliasIds: [ID_A, ID_B], primaryReceived: false },
      aliases([
        [ID_A, ALIAS_A],
        [ID_B, ALIAS_B],
      ]),
      PRIMARY,
    );
    expect(decision.selection).toBe("prompt");
    expect(decision.selected).toBeNull();
  });

  it("omits aliases that no longer resolve", () => {
    const decision = selectReplyIdentity(
      { aliasIds: [ID_A, ID_B], primaryReceived: false },
      aliases([[ID_A, ALIAS_A]]),
      PRIMARY,
    );
    // Only one resolvable alias remains, so it is selected rather than prompting.
    expect(decision.selection).toBe("default");
    expect(decision.selected).toEqual({ kind: "alias", aliasId: ID_A, address: ALIAS_A });
  });

  it("prompts when no identity is available", () => {
    const decision = selectReplyIdentity(
      { aliasIds: [ID_A], primaryReceived: false },
      aliases([]),
      null,
    );
    expect(decision.selection).toBe("prompt");
    expect(decision.selected).toBeNull();
    expect(decision.options).toEqual([]);
  });
});
