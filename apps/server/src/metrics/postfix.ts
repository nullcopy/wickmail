import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Count queued messages from `postqueue -j` output.
 *
 * `postqueue -j` prints one JSON object per queued message, so the count of
 * parseable non-empty lines is the queue depth. Malformed lines are ignored so
 * a partial write by an external collector never produces a bogus spike.
 */
export function countPostfixQueue(jsonLines: string): number {
  let count = 0;
  for (const line of jsonLines.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      JSON.parse(trimmed);
      count += 1;
    } catch {
      // A non-JSON line is not a queued message.
    }
  }
  return count;
}

/** Options for {@link readPostfixQueueDepth}. */
export interface PostfixQueueProbeOptions {
  /** A file holding `postqueue -j` output, written by an external collector. */
  file?: string;
  /** The queue inspection command. Defaults to `postqueue`. */
  command?: string;
  /** Arguments for the command. Defaults to `["-j"]`. */
  args?: string[];
}

/**
 * Best-effort Postfix queue depth.
 *
 * When `file` is set the depth is read from it, which is the recommended path
 * on a host where the server runs unprivileged and cannot inspect the Postfix
 * queue directly. Otherwise the command is run and its output counted. Any
 * failure returns `undefined`, so the scrape keeps the last known gauge rather
 * than failing.
 */
export function readPostfixQueueDepth(options: PostfixQueueProbeOptions = {}): number | undefined {
  if (options.file !== undefined) {
    try {
      return countPostfixQueue(readFileSync(options.file, "utf8"));
    } catch {
      return undefined;
    }
  }
  try {
    const output = execFileSync(options.command ?? "postqueue", options.args ?? ["-j"], {
      encoding: "utf8",
      timeout: 5000,
    });
    return countPostfixQueue(output);
  } catch {
    return undefined;
  }
}
