import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  SpoolFullError,
  SpoolUnavailableError,
  type NewSpooledMessage,
  type Spool,
  type SpooledMessage,
  type SpoolStats,
} from "./types.js";

/** The stored metadata for a spooled message; the body lives in a sibling `.eml`. */
type SpoolMetadata = Omit<SpooledMessage, "raw">;

/** Options for a filesystem spool. */
export interface FileSpoolOptions {
  /** The spool root; `tmp/` and `queue/` are created inside it. */
  directory: string;
}

const ENOSPC = "ENOSPC";

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function wrapError(error: unknown): Error {
  if (isErrno(error, ENOSPC)) {
    return new SpoolFullError("spool filesystem is full");
  }
  return new SpoolUnavailableError(
    `spool is unavailable: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** Map a filesystem error to the spool error the mail path reports. */
export function classifySpoolError(error: unknown): Error {
  return wrapError(error);
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * A durable filesystem spool for the single-host v1 layout.
 *
 * A message is written to `tmp/`, fsynced, and atomically renamed into
 * `queue/`, so a message that has been acknowledged is on disk. Delivery
 * failures leave the message in the queue for retry; there is no bounce path.
 */
export class FileSpool implements Spool {
  private readonly queueDirectory: string;
  private readonly tmpDirectory: string;

  constructor(options: FileSpoolOptions) {
    this.queueDirectory = join(options.directory, "queue");
    this.tmpDirectory = join(options.directory, "tmp");
    try {
      mkdirSync(this.queueDirectory, { recursive: true });
      mkdirSync(this.tmpDirectory, { recursive: true });
    } catch (error) {
      throw wrapError(error);
    }
  }

  private bodyPath(id: string): string {
    return join(this.queueDirectory, `${id}.eml`);
  }

  private metaPath(id: string): string {
    return join(this.queueDirectory, `${id}.json`);
  }

  private writeAtomic(target: string, contents: string): void {
    const name = target.split("/").pop() ?? target;
    const temp = join(
      this.tmpDirectory,
      `${name}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    try {
      writeFileSync(temp, contents);
      fsyncPath(temp);
      renameSync(temp, target);
      try {
        fsyncPath(this.queueDirectory);
      } catch {
        // Directory fsync is a durability nicety, not a correctness requirement.
      }
    } catch (error) {
      rmSync(temp, { force: true });
      throw wrapError(error);
    }
  }

  async enqueue(message: NewSpooledMessage): Promise<void> {
    const metadata: SpoolMetadata = { ...message, attempts: 0, nextAttemptAt: 0, lastError: null };
    // The body is written first so the metadata never points at a missing body.
    this.writeAtomic(this.bodyPath(message.id), message.raw);
    this.writeAtomic(this.metaPath(message.id), JSON.stringify(metadata));
  }

  private readMetadata(id: string): SpoolMetadata | undefined {
    const path = this.metaPath(id);
    if (!existsSync(path)) {
      return undefined;
    }
    return JSON.parse(readFileSync(path, "utf8")) as SpoolMetadata;
  }

  async list(): Promise<SpooledMessage[]> {
    const ids = readdirSync(this.queueDirectory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
    const messages: SpooledMessage[] = [];
    for (const id of ids) {
      const message = await this.get(id);
      if (message !== undefined) {
        messages.push(message);
      }
    }
    messages.sort((left, right) =>
      left.receivedAt === right.receivedAt
        ? left.id.localeCompare(right.id)
        : left.receivedAt - right.receivedAt,
    );
    return messages;
  }

  async get(id: string): Promise<SpooledMessage | undefined> {
    const metadata = this.readMetadata(id);
    if (metadata === undefined) {
      return undefined;
    }
    const bodyPath = this.bodyPath(id);
    if (!existsSync(bodyPath)) {
      return undefined;
    }
    return { ...metadata, raw: readFileSync(bodyPath, "utf8") };
  }

  async remove(id: string): Promise<void> {
    rmSync(this.metaPath(id), { force: true });
    rmSync(this.bodyPath(id), { force: true });
  }

  async recordAttempt(id: string, error: string, nextAttemptAt: number): Promise<void> {
    const metadata = this.readMetadata(id);
    if (metadata === undefined) {
      return;
    }
    const updated: SpoolMetadata = {
      ...metadata,
      attempts: metadata.attempts + 1,
      nextAttemptAt,
      lastError: error,
    };
    this.writeAtomic(this.metaPath(id), JSON.stringify(updated));
  }

  async stats(now: number): Promise<SpoolStats> {
    const messages = await this.list();
    if (messages.length === 0) {
      return { depth: 0, oldestAgeMs: null };
    }
    const oldest = messages[0]!;
    return { depth: messages.length, oldestAgeMs: Math.max(0, now - oldest.receivedAt) };
  }
}
