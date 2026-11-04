import { createServer, type Server, type Socket } from "node:net";
import type { RecipientDecision } from "./recipient.js";

/** A Postfix socketmap response status. */
export type SocketmapStatus = "OK" | "NOTFOUND" | "TEMP" | "TIMEOUT" | "PERM";

/** A decoded socketmap request. */
export interface SocketmapRequest {
  map: string;
  key: string;
}

/** A socketmap response. */
export interface SocketmapResponse {
  status: SocketmapStatus;
  text: string;
}

/**
 * Parse a socketmap request line: `mapname SP key NL`. The key may contain
 * spaces, so only the first space separates the map name from the key.
 */
export function parseSocketmapRequest(line: string): SocketmapRequest | undefined {
  const trimmed = line.replace(/\r?\n$/, "");
  if (trimmed.length === 0) {
    return undefined;
  }
  const space = trimmed.indexOf(" ");
  if (space <= 0) {
    return undefined;
  }
  return { map: trimmed.slice(0, space), key: trimmed.slice(space + 1) };
}

/** Encode a socketmap response line. */
export function encodeSocketmapResponse(response: SocketmapResponse): string {
  return response.text.length > 0
    ? `${response.status} ${response.text}\n`
    : `${response.status}\n`;
}

/**
 * Map a recipient decision to a Postfix `check_recipient_access` value.
 *
 * The socketmap lookup itself succeeds for every recipient; the value carries
 * the access decision. Unknown and disabled recipients become `REJECT`, and an
 * unavailable policy interface becomes `DEFER`, which Postfix maps to a
 * temporary failure.
 */
export function recipientAccessValue(decision: RecipientDecision): string {
  switch (decision.outcome) {
    case "accept":
      return "OK";
    case "reject":
      return `REJECT ${decision.reason === "disabled" ? "disabled recipient" : "unknown recipient"}`;
    case "tempfail":
      return "DEFER policy unavailable";
  }
}

/** Options for the socketmap server. */
export interface SocketmapServerOptions {
  /** The map name Postfix is configured to query. Defaults to `recipient`. */
  mapName?: string;
  /** Evaluate one lookup key. May throw to signal an internal error. */
  evaluate: (key: string) => RecipientDecision;
}

function handleLine(options: SocketmapServerOptions, line: string): string {
  const request = parseSocketmapRequest(line);
  if (request === undefined) {
    return encodeSocketmapResponse({ status: "PERM", text: "malformed request" });
  }
  if (request.map !== (options.mapName ?? "recipient")) {
    return encodeSocketmapResponse({ status: "NOTFOUND", text: "" });
  }
  try {
    return encodeSocketmapResponse({
      status: "OK",
      text: recipientAccessValue(options.evaluate(request.key)),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return encodeSocketmapResponse({ status: "TEMP", text: reason });
  }
}

/**
 * Create a Postfix socketmap server. It answers `check_recipient_access`
 * lookups and never returns `NOTFOUND` for a known map, because Postfix treats
 * a missing key as no restriction and would accept an unknown recipient.
 *
 * The caller binds the server to a Unix socket or TCP address.
 */
export function createSocketmapServer(options: SocketmapServerOptions): Server {
  return createServer((socket: Socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline + 1);
        buffer = buffer.slice(newline + 1);
        socket.write(handleLine(options, line));
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => {
      socket.destroy();
    });
  });
}
