import { canonicalizeAddress } from "../alias/canonical.js";
import { getHeaderValues } from "./headers.js";

/** Extract the address from an SMTP path argument such as `<user@example.com>`. */
export function parsePathAddress(argument: string): string {
  const trimmed = argument.trim();
  const angle = trimmed.match(/^<([^>]*)>$/);
  return (angle?.[1] ?? trimmed).trim();
}

/**
 * A recipient list split into the authoritative envelope set and the visible
 * `To`/`Cc` set. The envelope is authoritative and includes blind copies; the
 * visible set is cross-checked for display only.
 */
export interface RecipientCrossCheck {
  /** Canonical envelope recipients, in receipt order, deduplicated. */
  envelope: string[];
  /** Canonical recipients found in visible `To` and `Cc`. */
  visible: string[];
  /** Envelope recipients that were not visible, such as blind copies. */
  envelopeOnly: string[];
  /** Visible recipients that were not in the envelope. */
  visibleOnly: string[];
}

/** The visible `To` and `Cc` addresses of a message, canonicalized. */
export function visibleRecipients(raw: string): string[] {
  const values = [...getHeaderValues(raw, "To"), ...getHeaderValues(raw, "Cc")];
  const addresses: string[] = [];
  for (const value of values) {
    for (const candidate of splitAddressList(value)) {
      try {
        addresses.push(canonicalizeAddress(candidate));
      } catch {
        // A display-only address that cannot be canonicalized is ignored.
      }
    }
  }
  return addresses;
}

function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let angleDepth = 0;
  for (const character of value) {
    if (character === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && character === "<") {
      angleDepth += 1;
    } else if (!inQuotes && character === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
    } else if (!inQuotes && angleDepth === 0 && character === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) {
    parts.push(current);
  }
  return parts
    .map((part) => {
      const match = part.match(/<([^>]*)>/);
      return (match?.[1] ?? part).trim();
    })
    .filter((part) => part.includes("@"));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Cross-check the authoritative envelope recipients against the visible `To`
 * and `Cc`. A mismatch never changes delivery or provenance; it is display
 * metadata only.
 */
export function crossCheckRecipients(
  envelopeRecipients: readonly string[],
  raw: string,
): RecipientCrossCheck {
  const envelope = unique(envelopeRecipients.map(canonicalize));
  const visible = unique(visibleRecipients(raw));
  const envelopeSet = new Set(envelope);
  const visibleSet = new Set(visible);
  return {
    envelope,
    visible,
    envelopeOnly: envelope.filter((address) => !visibleSet.has(address)),
    visibleOnly: visible.filter((address) => !envelopeSet.has(address)),
  };
}

function canonicalize(address: string): string {
  try {
    return canonicalizeAddress(address);
  } catch {
    return address.trim().toLowerCase();
  }
}
