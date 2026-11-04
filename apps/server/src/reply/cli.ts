import type { ReplyRequest } from "wickmail-core";
import type { ReplyClient } from "./client.js";

/** Output sinks for the reply CLI. */
export interface ReplyCliIo {
  out(line: string): void;
  err(line: string): void;
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      flags.set(name, "");
    } else {
      flags.set(name, value);
      index += 1;
    }
  }
  return { positionals, flags };
}

const USAGE = [
  "usage:",
  "  context <messageId>",
  "  reply <messageId> [--alias <aliasId>] [--body <text>] [--quote <text>]",
].join("\n");

/**
 * Run the reply CLI against a {@link ReplyClient}.
 *
 * `context` prints the sanitized reply context; `reply` submits a reply as the
 * selected alias (or the primary identity when `--alias` is omitted). Both
 * commands go through the same server-side rules as any other client.
 */
export async function runReplyCli(
  argv: readonly string[],
  client: ReplyClient,
  io: ReplyCliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  const { positionals, flags } = parseArgs(rest);

  if (command === "context") {
    const messageId = positionals[0];
    if (messageId === undefined) {
      io.err(USAGE);
      return 2;
    }
    const context = await client.fetchReplyContext(messageId);
    if (context === undefined) {
      io.err(`no reply context for message ${messageId}`);
      return 1;
    }
    io.out(JSON.stringify(context, null, 2));
    return 0;
  }

  if (command === "reply") {
    const messageId = positionals[0];
    if (messageId === undefined) {
      io.err(USAGE);
      return 2;
    }
    const aliasId = flags.get("alias");
    const quotedText = flags.get("quote");
    const request: ReplyRequest = {
      body: flags.get("body") ?? "",
      ...(aliasId !== undefined && aliasId.length > 0 ? { aliasId } : {}),
      ...(quotedText !== undefined ? { quotedText } : {}),
    };
    const result = await client.submitReply(messageId, request);
    io.out(JSON.stringify(result, null, 2));
    return result.status === "queued" ? 0 : 1;
  }

  io.err(USAGE);
  return 2;
}
