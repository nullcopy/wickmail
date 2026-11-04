import { randomInt as secureRandomInt } from "node:crypto";
import { canonicalizeAddress } from "./canonical.js";
import { defaultWordList } from "./words.js";

/** Thrown when a unique alias cannot be generated within the attempt budget. */
export class AliasGenerationError extends Error {
  override name = "AliasGenerationError";
}

/** A function that returns an unbiased integer in `[0, maxExclusive)`. */
export type RandomIndex = (maxExclusive: number) => number;

/**
 * The default random index source: the `crypto` CSPRNG, which returns an
 * unbiased integer in `[0, maxExclusive)`.
 */
export function secureRandomIndex(maxExclusive: number): number {
  return secureRandomInt(maxExclusive);
}

/** A uniqueness predicate over a canonical address. */
export type AddressUniquenessCheck = (canonicalAddress: string) => boolean;

/** Options for alias generation. */
export interface AliasGeneratorOptions {
  /** The alias domain, canonicalized before use. */
  domain: string;
  /** Returns true when the canonical address is already taken. */
  isTaken: AddressUniquenessCheck;
  /** The word list to draw from. Defaults to the curated list. */
  wordList?: readonly string[];
  /** Words in the default local part. Defaults to two. */
  wordCount?: number;
  /** Maximum generation attempts before giving up. Defaults to ten. */
  maxAttempts?: number;
  /** Attempts at one word count before adding another word. Defaults to half the budget. */
  attemptsBeforeExtraWord?: number;
  /** Random index source. Defaults to the `crypto` CSPRNG. */
  randomIndex?: RandomIndex;
}

/** A generated alias address. */
export interface GeneratedAlias {
  /** The generated local part, such as `green.farm`. */
  localPart: string;
  /** The canonical full address. */
  address: string;
  /** The number of words in the local part. */
  wordCount: number;
  /** The number of attempts used, starting at one. */
  attempts: number;
}

function pickWord(wordList: readonly string[], randomIndex: RandomIndex): string {
  const index = randomIndex(wordList.length);
  if (!Number.isInteger(index) || index < 0 || index >= wordList.length) {
    throw new RangeError(`random index ${index} is out of range for a list of ${wordList.length}`);
  }
  const word = wordList[index];
  if (word === undefined) {
    throw new RangeError(`word list has no entry at index ${index}`);
  }
  return word;
}

/**
 * Build a local part from randomly selected dictionary words. Words are joined
 * with a dot, so a two-word part reads as `green.farm`.
 */
export function generateLocalPart(
  options: {
    wordCount?: number;
    wordList?: readonly string[];
    randomIndex?: RandomIndex;
  } = {},
): string {
  const wordList = options.wordList ?? defaultWordList;
  const wordCount = options.wordCount ?? 2;
  const randomIndex = options.randomIndex ?? secureRandomIndex;
  if (wordList.length < 2) {
    throw new AliasGenerationError("word list must contain at least two words");
  }
  if (wordCount < 1) {
    throw new AliasGenerationError("word count must be at least one");
  }
  const words: string[] = [];
  for (let index = 0; index < wordCount; index += 1) {
    words.push(pickWord(wordList, randomIndex));
  }
  return words.join(".");
}

/**
 * Generate a canonical alias address that passes the uniqueness check.
 *
 * Selection uses the `crypto` CSPRNG by default. On collision the generator
 * retries and, once the attempt budget for the current word count is spent,
 * adds another word to widen the namespace. The check is injected so the
 * retry behavior is unit-testable without a database.
 */
export function generateAlias(options: AliasGeneratorOptions): GeneratedAlias {
  const wordList = options.wordList ?? defaultWordList;
  const baseWordCount = options.wordCount ?? 2;
  const maxAttempts = options.maxAttempts ?? 10;
  const attemptsBeforeExtraWord = options.attemptsBeforeExtraWord ?? Math.ceil(maxAttempts / 2);
  const randomIndex = options.randomIndex ?? secureRandomIndex;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const extraWords = Math.floor((attempt - 1) / attemptsBeforeExtraWord);
    const wordCount = baseWordCount + extraWords;
    const localPart = generateLocalPart({ wordCount, wordList, randomIndex });
    const address = canonicalizeAddress(`${localPart}@${options.domain}`);
    if (!options.isTaken(address)) {
      return { localPart, address, wordCount, attempts: attempt };
    }
  }

  throw new AliasGenerationError(`could not generate a unique alias after ${maxAttempts} attempts`);
}
