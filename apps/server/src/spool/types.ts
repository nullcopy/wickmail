import type { MailRoute } from "wickmail-core";

/** A message accepted into the spool, with the trusted metadata computed at delivery. */
export interface SpooledMessage {
  /** The trusted `X-Wickmail-Message-ID`. */
  id: string;
  /** The SMTP envelope sender. */
  mailFrom: string;
  /** The SMTP envelope recipients. */
  rcptTo: string[];
  /** The trusted delivery route. */
  route: MailRoute;
  /** The receiving alias IDs. */
  aliasIds: string[];
  /** Whether the primary address received the message. */
  primaryReceived: boolean;
  /** Acceptance time in epoch milliseconds. */
  receivedAt: number;
  /** The message with trusted headers applied. */
  raw: string;
  /** Delivery attempts made so far. */
  attempts: number;
  /** The earliest time the next attempt may run, in epoch milliseconds. */
  nextAttemptAt: number;
  /** The most recent delivery error, or null. */
  lastError: string | null;
}

/** A message handed to the spool for the first time. */
export type NewSpooledMessage = Omit<SpooledMessage, "attempts" | "nextAttemptAt" | "lastError">;

/** Spool depth and age, for monitoring. */
export interface SpoolStats {
  /** The number of messages waiting to be delivered. */
  depth: number;
  /** The age of the oldest spooled message in milliseconds, or null when empty. */
  oldestAgeMs: number | null;
}

/** Thrown when the spool cannot store a message because the filesystem is full. */
export class SpoolFullError extends Error {
  override name = "SpoolFullError";
}

/** Thrown when the spool cannot store a message for any other reason. */
export class SpoolUnavailableError extends Error {
  override name = "SpoolUnavailableError";
}

/** A durable message spool. */
export interface Spool {
  /** Durably store a message before it is acknowledged. */
  enqueue(message: NewSpooledMessage): Promise<void>;
  /** Every message waiting for delivery, oldest first. */
  list(): Promise<SpooledMessage[]>;
  /** One message by ID, or undefined. */
  get(id: string): Promise<SpooledMessage | undefined>;
  /** Remove a message after successful delivery. */
  remove(id: string): Promise<void>;
  /** Record a failed attempt and schedule the next one. */
  recordAttempt(id: string, error: string, nextAttemptAt: number): Promise<void>;
  /** Current depth and age. */
  stats(now: number): Promise<SpoolStats>;
}
