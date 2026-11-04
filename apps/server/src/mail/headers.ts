import { WICKMAIL_HEADER_PREFIX } from "wickmail-core";

/** A parsed header field, preserving its raw (possibly folded) form. */
export interface HeaderField {
  /** The field name as it appeared, without the trailing colon. */
  name: string;
  /** The unfolded field value, trimmed. */
  value: string;
  /** The raw field text, including any folded continuation lines. */
  raw: string;
}

/** A message split into its header block and body. */
export interface ParsedMessage {
  headers: HeaderField[];
  body: string;
}

const CRLF = "\r\n";
const SEPARATOR = `${CRLF}${CRLF}`;

/** Normalize CRLF, bare CR, and bare LF line endings to CRLF. */
export function normalizeNewlines(input: string): string {
  return input.replace(/\r\n|\r|\n/g, CRLF);
}

function parseHeaderBlock(block: string): HeaderField[] {
  const fields: HeaderField[] = [];
  for (const line of block.split(CRLF)) {
    if (line.length === 0) {
      continue;
    }
    const isContinuation = line.startsWith(" ") || line.startsWith("\t");
    if (isContinuation) {
      const previous = fields[fields.length - 1];
      if (previous === undefined) {
        continue;
      }
      previous.raw += `${CRLF}${line}`;
      previous.value = `${previous.value} ${line.trim()}`.trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      // A malformed header line without a field name is dropped rather than
      // mistaken for a valid field.
      continue;
    }
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    fields.push({ name, value, raw: line });
  }
  return fields;
}

/** Split a raw message into parsed headers and the body. */
export function parseMessage(raw: string): ParsedMessage {
  const normalized = normalizeNewlines(raw);
  const separator = normalized.indexOf(SEPARATOR);
  if (separator === -1) {
    return { headers: parseHeaderBlock(normalized), body: "" };
  }
  return {
    headers: parseHeaderBlock(normalized.slice(0, separator)),
    body: normalized.slice(separator + SEPARATOR.length),
  };
}

/** Serialize parsed headers and a body back into a raw CRLF message. */
export function serializeMessage(headers: readonly HeaderField[], body: string): string {
  const headerBlock = headers.map((field) => field.raw).join(CRLF);
  return `${headerBlock}${SEPARATOR}${body}`;
}

/** Whether a field name is in the reserved `X-Wickmail-*` namespace. */
export function isWickmailHeader(name: string): boolean {
  return name.trim().toLowerCase().startsWith(WICKMAIL_HEADER_PREFIX.toLowerCase());
}

/** A field to add to a message. */
export interface AddedHeader {
  name: string;
  value: string;
}

function fieldFrom(header: AddedHeader): HeaderField {
  return { name: header.name, value: header.value, raw: `${header.name}: ${header.value}` };
}

/**
 * Remove every field whose name satisfies `predicate`, returning the new raw
 * message and the names that were removed. The body is preserved verbatim.
 */
export function stripHeaders(
  raw: string,
  predicate: (name: string) => boolean,
): { raw: string; removed: string[] } {
  const { headers, body } = parseMessage(raw);
  const kept: HeaderField[] = [];
  const removed: string[] = [];
  for (const header of headers) {
    if (predicate(header.name)) {
      removed.push(header.name);
    } else {
      kept.push(header);
    }
  }
  return { raw: serializeMessage(kept, body), removed };
}

/**
 * Strip every client-supplied `X-Wickmail-*` header. Trusted headers are only
 * added after this step, so a client cannot influence routing.
 */
export function stripWickmailHeaders(raw: string): { raw: string; removed: string[] } {
  return stripHeaders(raw, isWickmailHeader);
}

/**
 * Add trusted headers at the top of the message, after stripping client
 * headers. Existing trusted headers should already have been removed.
 */
export function addHeaders(raw: string, headers: readonly AddedHeader[]): string {
  if (headers.length === 0) {
    return raw;
  }
  const { headers: existing, body } = parseMessage(raw);
  return serializeMessage([...headers.map(fieldFrom), ...existing], body);
}

/** All values of a header field, unfolded and in order. */
export function getHeaderValues(raw: string, name: string): string[] {
  const target = name.trim().toLowerCase();
  return parseMessage(raw)
    .headers.filter((header) => header.name.trim().toLowerCase() === target)
    .map((header) => header.value);
}

/** The first value of a header field, or undefined when absent. */
export function getHeader(raw: string, name: string): string | undefined {
  return getHeaderValues(raw, name)[0];
}
