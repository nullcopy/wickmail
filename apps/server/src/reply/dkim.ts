import {
  createHash,
  createPrivateKey,
  createSign,
  createVerify,
  type KeyObject,
} from "node:crypto";
import { getHeader, parseMessage, type HeaderField } from "../mail/headers.js";

/** The headers signed by default, when present in the message. */
export const DEFAULT_DKIM_HEADERS = [
  "from",
  "to",
  "subject",
  "date",
  "message-id",
  "in-reply-to",
  "references",
  "mime-version",
  "content-type",
] as const;

/** A signer that returns a DKIM-signed message. */
export type DkimSigner = (raw: string, context: { domain: string; now: number }) => string;

/** Options for DKIM signing. */
export interface DkimSigningOptions {
  /** The signing domain, aligned with the `From` domain for DMARC. */
  domain: string;
  /** The DNS selector published for the key. */
  selector: string;
  /** The RSA private key, as PEM text or a `KeyObject`. */
  privateKey: string | KeyObject;
  /** Header names to sign, in order. Defaults to {@link DEFAULT_DKIM_HEADERS}. */
  headers?: readonly string[];
  /** Signing time in epoch milliseconds. Defaults to `Date.now()`. */
  now?: number;
}

/** Canonicalize a header value with the relaxed algorithm. */
function canonicalizeHeaderValue(value: string): string {
  return value
    .replace(/\r?\n/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Canonicalize a header field with the relaxed algorithm. */
function canonicalizeHeaderField(name: string, value: string): string {
  return `${name.trim().toLowerCase()}:${canonicalizeHeaderValue(value)}`;
}

/**
 * Canonicalize a body with the relaxed algorithm: reduce whitespace runs to a
 * single space, drop trailing whitespace, remove trailing empty lines, and end
 * a non-empty body with CRLF.
 */
export function canonicalizeBodyRelaxed(body: string): string {
  const lines = body.replace(/\r\n|\r|\n/g, "\n").split("\n");
  const normalized = lines.map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/, ""));
  while (normalized.length > 0 && normalized[normalized.length - 1] === "") {
    normalized.pop();
  }
  return normalized.length === 0 ? "" : `${normalized.join("\r\n")}\r\n`;
}

function lastHeader(headers: readonly HeaderField[], name: string): HeaderField | undefined {
  const target = name.trim().toLowerCase();
  for (let index = headers.length - 1; index >= 0; index -= 1) {
    const header = headers[index]!;
    if (header.name.trim().toLowerCase() === target) {
      return header;
    }
  }
  return undefined;
}

interface DkimTag {
  name: string;
  value: string;
}

function parseTags(value: string): DkimTag[] {
  const tags: DkimTag[] = [];
  for (const segment of value.split(";")) {
    const equals = segment.indexOf("=");
    if (equals === -1) {
      continue;
    }
    const name = segment.slice(0, equals).trim();
    if (name.length === 0) {
      continue;
    }
    tags.push({ name, value: segment.slice(equals + 1).trim() });
  }
  return tags;
}

function privateKeyObject(key: string | KeyObject): string | KeyObject {
  return typeof key === "string" ? createPrivateKey(key) : key;
}

/**
 * DKIM-sign a message with the alias domain's key.
 *
 * The signature uses `relaxed/relaxed` canonicalization and `rsa-sha256`, and
 * is placed at the top of the message. The `d=` tag is the signing domain,
 * which equals the `From` domain, so the result is DMARC-aligned.
 */
export function signMessage(raw: string, options: DkimSigningOptions): string {
  const now = options.now ?? Date.now();
  const parsed = parseMessage(raw);

  const requested = (options.headers ?? DEFAULT_DKIM_HEADERS).map((name) =>
    name.trim().toLowerCase(),
  );
  if (!requested.includes("from")) {
    requested.unshift("from");
  }

  const canonicalHeaders: string[] = [];
  const signedNames: string[] = [];
  for (const name of requested) {
    const header = lastHeader(parsed.headers, name);
    if (header === undefined) {
      continue;
    }
    canonicalHeaders.push(canonicalizeHeaderField(header.name, header.value));
    signedNames.push(name);
  }

  const bodyHash = createHash("sha256")
    .update(canonicalizeBodyRelaxed(parsed.body), "utf8")
    .digest("base64");

  const tags: DkimTag[] = [
    { name: "v", value: "1" },
    { name: "a", value: "rsa-sha256" },
    { name: "c", value: "relaxed/relaxed" },
    { name: "d", value: options.domain },
    { name: "s", value: options.selector },
    { name: "t", value: String(Math.floor(now / 1000)) },
    { name: "h", value: signedNames.join(":") },
    { name: "bh", value: bodyHash },
    { name: "b", value: "" },
  ];

  const emptyValue = tags.map((tag) => `${tag.name}=${tag.value}`).join("; ");
  const signingInput =
    canonicalHeaders.map((header) => `${header}\r\n`).join("") +
    canonicalizeHeaderField("DKIM-Signature", emptyValue);

  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKeyObject(options.privateKey), "base64");

  const signedValue = tags
    .map((tag) => `${tag.name}=${tag.name === "b" ? signature : tag.value}`)
    .join("; ");

  return `DKIM-Signature: ${signedValue}\r\n${raw}`;
}

/** Build a {@link DkimSigner} from signing options without a fixed domain. */
export function createDkimSigner(options: Omit<DkimSigningOptions, "domain">): DkimSigner {
  return (raw, context) =>
    signMessage(raw, { ...options, domain: context.domain, now: context.now });
}

/** The result of verifying a DKIM signature. */
export interface DkimVerificationResult {
  valid: boolean;
  domain: string | null;
  selector: string | null;
  reason: string | null;
}

/**
 * Verify the DKIM signature on a message against a public key. It checks the
 * body hash and the header signature. It does not perform DNS lookup.
 */
export function verifyDkimSignature(
  raw: string,
  publicKey: string | KeyObject,
): DkimVerificationResult {
  const value = getHeader(raw, "DKIM-Signature");
  if (value === undefined) {
    return { valid: false, domain: null, selector: null, reason: "missing DKIM-Signature" };
  }

  const tags = parseTags(value);
  const tag = (name: string): string | undefined =>
    tags.find((entry) => entry.name === name)?.value;
  const domain = tag("d") ?? null;
  const selector = tag("s") ?? null;
  const bodyHash = tag("bh");
  const signature = tag("b");
  const headerList = tag("h");
  if (bodyHash === undefined || signature === undefined || headerList === undefined) {
    return { valid: false, domain, selector, reason: "incomplete DKIM-Signature" };
  }

  const parsed = parseMessage(raw);
  const computedBodyHash = createHash("sha256")
    .update(canonicalizeBodyRelaxed(parsed.body), "utf8")
    .digest("base64");
  if (computedBodyHash !== bodyHash) {
    return { valid: false, domain, selector, reason: "body hash mismatch" };
  }

  const canonicalHeaders: string[] = [];
  for (const name of headerList.split(":").map((entry) => entry.trim().toLowerCase())) {
    const header = lastHeader(parsed.headers, name);
    if (header === undefined) {
      continue;
    }
    canonicalHeaders.push(canonicalizeHeaderField(header.name, header.value));
  }

  const emptyValue = tags
    .map((entry) => `${entry.name}=${entry.name === "b" ? "" : entry.value}`)
    .join("; ");
  const signingInput =
    canonicalHeaders.map((header) => `${header}\r\n`).join("") +
    canonicalizeHeaderField("DKIM-Signature", emptyValue);

  const valid = createVerify("RSA-SHA256")
    .update(signingInput)
    .verify(publicKey, signature, "base64");
  return { valid, domain, selector, reason: valid ? null : "signature mismatch" };
}

/**
 * Whether a DKIM signing domain is DMARC-aligned with the `From` domain. v1
 * uses strict alignment: the domains must be equal.
 */
export function dmarcAligned(fromDomain: string, dkimDomain: string): boolean {
  return fromDomain.trim().toLowerCase() === dkimDomain.trim().toLowerCase();
}
