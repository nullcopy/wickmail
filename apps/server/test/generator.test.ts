import { describe, expect, it } from "vitest";
import {
  AliasGenerationError,
  generateAlias,
  generateLocalPart,
  secureRandomIndex,
  type RandomIndex,
} from "../src/alias/generator.js";
import { defaultWordList } from "../src/alias/words.js";
import { TEST_DOMAIN } from "./helpers.js";

function sequence(values: readonly number[]): RandomIndex {
  let index = 0;
  return (maxExclusive) => {
    const value = values[index % values.length];
    index += 1;
    if (value === undefined) {
      throw new Error("sequence exhausted");
    }
    return value % maxExclusive;
  };
}

describe("defaultWordList", () => {
  it("is a few hundred lowercase ASCII words with no duplicates", () => {
    expect(defaultWordList.length).toBeGreaterThanOrEqual(200);
    const seen = new Set<string>();
    for (const word of defaultWordList) {
      expect(word, word).toMatch(/^[a-z]+$/);
      expect(seen.has(word), `duplicate word: ${word}`).toBe(false);
      seen.add(word);
    }
  });
});

describe("secureRandomIndex", () => {
  it("returns integers within range and both values for a two-way choice", () => {
    const observed = new Set<number>();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = secureRandomIndex(2);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(2);
      observed.add(value);
    }
    expect(observed.size).toBe(2);
  });
});

describe("generateLocalPart", () => {
  it("joins two dictionary words with a dot by default", () => {
    const localPart = generateLocalPart({ randomIndex: sequence([0, 1]) });
    expect(localPart).toBe(`${defaultWordList[0]}.${defaultWordList[1]}`);
    expect(localPart.split(".").every((word) => defaultWordList.includes(word))).toBe(true);
  });

  it("honours a custom word count", () => {
    const localPart = generateLocalPart({ wordCount: 3, randomIndex: sequence([0, 1, 2]) });
    expect(localPart.split(".")).toHaveLength(3);
  });

  it("rejects a random index outside the list", () => {
    expect(() => generateLocalPart({ randomIndex: () => 999 })).toThrow(RangeError);
  });
});

describe("generateAlias", () => {
  it("produces a readable canonical address with no policy in it", () => {
    const generated = generateAlias({ domain: TEST_DOMAIN, isTaken: () => false });
    expect(generated.address).toMatch(/^[a-z]+\.[a-z]+@example\.com$/);
    expect(generated.localPart).not.toMatch(/[0-9]/);
    expect(generated.wordCount).toBe(2);
    expect(generated.attempts).toBe(1);
  });

  it("varies across many draws using the default CSPRNG", () => {
    const addresses = new Set<string>();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      addresses.add(generateAlias({ domain: TEST_DOMAIN, isTaken: () => false }).address);
    }
    expect(addresses.size).toBeGreaterThan(1);
  });

  it("retries on collision and returns the first unique address", () => {
    let calls = 0;
    const generated = generateAlias({
      domain: TEST_DOMAIN,
      randomIndex: sequence([0, 1]),
      isTaken: () => {
        calls += 1;
        return calls === 1;
      },
    });
    expect(generated.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  it("adds a word once the attempt budget for the current length is spent", () => {
    const generated = generateAlias({
      domain: TEST_DOMAIN,
      maxAttempts: 4,
      attemptsBeforeExtraWord: 2,
      randomIndex: sequence([0, 1, 2]),
      isTaken: (address) => address.split("@")[0]!.split(".").length === 2,
    });
    expect(generated.wordCount).toBe(3);
    expect(generated.attempts).toBe(3);
  });

  it("throws when no unique address is found within the budget", () => {
    expect(() =>
      generateAlias({ domain: TEST_DOMAIN, maxAttempts: 3, isTaken: () => true }),
    ).toThrow(AliasGenerationError);
  });

  it("canonicalizes the domain", () => {
    const generated = generateAlias({ domain: "Example.COM.", isTaken: () => false });
    expect(generated.address.endsWith("@example.com")).toBe(true);
  });
});
