import { domainToASCII } from "node:url";

/** Thrown when an address cannot be canonicalized. */
export class CanonicalizationError extends Error {
  override name = "CanonicalizationError";
}

/**
 * Canonicalize an email local part to lowercase ASCII.
 *
 * Plus addressing is not supported in v1: a `+` is preserved rather than
 * stripped, so a tagged recipient never matches a canonical alias address.
 */
export function canonicalizeLocalPart(localPart: string): string {
  const trimmed = localPart.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new CanonicalizationError("local part is empty");
  }
  // SMTPUTF8 is out of scope for v1; local parts are ASCII.
  for (const character of trimmed) {
    if (character.codePointAt(0)! > 0x7f) {
      throw new CanonicalizationError("local part must be ASCII");
    }
  }
  return trimmed;
}

/**
 * Canonicalize an email domain to lowercase ASCII or punycode. A single
 * trailing dot is dropped so fully qualified names match their bare form.
 */
export function canonicalizeDomain(domain: string): string {
  let trimmed = domain.trim().toLowerCase();
  if (trimmed.endsWith(".")) {
    trimmed = trimmed.slice(0, -1);
  }
  if (trimmed.length === 0) {
    throw new CanonicalizationError("domain is empty");
  }
  const ascii = domainToASCII(trimmed);
  if (ascii.length === 0) {
    throw new CanonicalizationError(`domain cannot be converted to ASCII: ${domain}`);
  }
  return ascii;
}

/**
 * Canonicalize a full email address to `local@domain`. Uniqueness and lookup
 * are enforced on this value, which makes alias lookup case-insensitive and
 * stable across IDN and ASCII domain spellings.
 */
export function canonicalizeAddress(address: string): string {
  const separator = address.lastIndexOf("@");
  if (separator <= 0 || separator === address.length - 1) {
    throw new CanonicalizationError(`address must be local@domain: ${address}`);
  }
  const localPart = canonicalizeLocalPart(address.slice(0, separator));
  const domain = canonicalizeDomain(address.slice(separator + 1));
  return `${localPart}@${domain}`;
}

/** Split a canonical address into its local part and domain. */
export function splitCanonicalAddress(canonicalAddress: string): {
  localPart: string;
  domain: string;
} {
  const separator = canonicalAddress.lastIndexOf("@");
  return {
    localPart: canonicalAddress.slice(0, separator),
    domain: canonicalAddress.slice(separator + 1),
  };
}
