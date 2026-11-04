import { canonicalizeAddress } from "../alias/canonical.js";
import { getHeader, parseMessage } from "../mail/headers.js";

/** The default maximum length of a sanitized header value. */
export const MAX_HEADER_VALUE_LENGTH = 998;

/** The default maximum length of sanitized body text. */
export const MAX_BODY_TEXT_LENGTH = 100_000;

/**
 * Remove control characters and line breaks from a header value so it cannot
 * inject headers or smuggle content, and cap its length.
 */
export function sanitizeHeaderValue(
  value: string,
  maxLength: number = MAX_HEADER_VALUE_LENGTH,
): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

/**
 * Normalize body text: CRLF to LF, drop control characters other than tab and
 * newline, collapse runs of blank lines, trim, and cap the length.
 */
export function sanitizeText(text: string, maxLength: number = MAX_BODY_TEXT_LENGTH): string {
  const normalized = text
    .replace(/\r\n|\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

/** The first mailbox address in a header value, canonicalized, or null. */
export function sanitizeSender(raw: string): string | null {
  const value = getHeader(raw, "From");
  if (value === undefined) {
    return null;
  }
  const angle = value.match(/<([^>]*)>/);
  const candidate = (angle?.[1] ?? value).trim();
  try {
    return canonicalizeAddress(candidate);
  } catch {
    return null;
  }
}

/** The sanitized `Subject` header, or null when absent or empty. */
export function sanitizeSubject(raw: string): string | null {
  const value = getHeader(raw, "Subject");
  if (value === undefined) {
    return null;
  }
  const cleaned = sanitizeHeaderValue(value);
  return cleaned.length === 0 ? null : cleaned;
}

/** Decode a quoted-printable body, interpreting encoded bytes as UTF-8. */
function decodeQuotedPrintable(body: string): string {
  const input = body.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === "=" && /^[0-9a-fA-F]{2}$/.test(input.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(input.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else {
      bytes.push(...Buffer.from(character, "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Decode a body according to its `Content-Transfer-Encoding`. */
function decodeTransferEncoding(body: string, encoding: string | undefined): string {
  const normalized = (encoding ?? "7bit").trim().toLowerCase();
  if (normalized === "base64") {
    try {
      return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      return body;
    }
  }
  if (normalized === "quoted-printable") {
    return decodeQuotedPrintable(body);
  }
  return body;
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** Strip HTML tags and decode common entities, preserving line breaks. */
function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity);
}

interface MimePart {
  contentType: string;
  encoding: string | undefined;
  body: string;
}

function parsePart(raw: string): MimePart {
  const parsed = parseMessage(raw);
  const contentType = parsed.headers
    .find((header) => header.name.toLowerCase() === "content-type")
    ?.value.split(";")[0]
    ?.trim()
    .toLowerCase();
  const encoding = parsed.headers.find(
    (header) => header.name.toLowerCase() === "content-transfer-encoding",
  )?.value;
  return { contentType: contentType ?? "text/plain", encoding, body: parsed.body };
}

function bodyFromMultipart(body: string, boundary: string): string {
  const parts = body
    .split(`--${boundary}`)
    .slice(1)
    .map((part) => part.replace(/^[\r\n]+/, "").replace(/[\r\n]+$/, ""))
    .filter((part) => part.length > 0 && part !== "--");
  const parsed = parts.map((part) => parsePart(part));
  const plain = parsed.find((part) => part.contentType === "text/plain");
  if (plain !== undefined) {
    return decodeTransferEncoding(plain.body, plain.encoding);
  }
  const html = parsed.find((part) => part.contentType === "text/html");
  if (html !== undefined) {
    return stripHtml(decodeTransferEncoding(html.body, html.encoding));
  }
  return "";
}

/**
 * Extract the sanitized plain-text body of a message. A multipart message
 * prefers its `text/plain` part; `text/html` is reduced to text. The result is
 * normalized and capped. Message bodies are never logged.
 */
export function extractTextBody(raw: string): string {
  const parsed = parseMessage(raw);
  const contentTypeHeader = parsed.headers.find(
    (header) => header.name.toLowerCase() === "content-type",
  )?.value;
  const encoding = parsed.headers.find(
    (header) => header.name.toLowerCase() === "content-transfer-encoding",
  )?.value;
  const contentType = (contentTypeHeader ?? "text/plain").toLowerCase();

  if (contentType.startsWith("multipart/")) {
    const boundary = contentTypeHeader?.match(/boundary="?([^";]+)"?/i)?.[1];
    if (boundary !== undefined && boundary.length > 0) {
      return sanitizeText(bodyFromMultipart(parsed.body, boundary));
    }
    return "";
  }

  const decoded = decodeTransferEncoding(parsed.body, encoding);
  if (contentType.startsWith("text/html")) {
    return sanitizeText(stripHtml(decoded));
  }
  return sanitizeText(decoded);
}
