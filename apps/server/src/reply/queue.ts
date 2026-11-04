import { randomUUID } from "node:crypto";

/** A message queued for outbound delivery. */
export interface OutboundMessage {
  /** The queue identity, used for idempotent removal and retries. */
  id: string;
  /** The alias the message was sent as, or null for the primary identity. */
  aliasId: string | null;
  /** The SMTP envelope sender. */
  envelopeSender: string;
  /** The SMTP envelope recipients. */
  envelopeRecipients: string[];
  /** The signed raw message. */
  raw: string;
  /** The time the message was accepted, in epoch milliseconds. */
  queuedAt: number;
  /** Delivery attempts made so far. */
  attempts: number;
  /** The earliest time the next attempt may run, in epoch milliseconds. */
  nextAttemptAt: number;
  /** The most recent delivery error, or null. */
  lastError: string | null;
}

/** A message handed to the outbound queue for the first time. */
export type NewOutboundMessage = Omit<OutboundMessage, "attempts" | "nextAttemptAt" | "lastError">;

/** The outbound submission queue. */
export interface OutboundQueue {
  /** Accept a message for delivery. */
  enqueue(message: NewOutboundMessage): Promise<void>;
  /** Every queued message, oldest first. */
  list(): Promise<OutboundMessage[]>;
  /** One message by ID, or undefined. */
  get(id: string): Promise<OutboundMessage | undefined>;
  /** Remove a message after successful delivery. */
  remove(id: string): Promise<void>;
  /** Record a failed attempt and schedule the next one. */
  recordAttempt(id: string, error: string, nextAttemptAt: number): Promise<void>;
}

/**
 * An in-memory outbound queue for the walking skeleton. Submission logic is
 * independent of the queue implementation, so a durable queue can replace it
 * without changing the reply path.
 */
export class MemoryOutboundQueue implements OutboundQueue {
  private readonly messages = new Map<string, OutboundMessage>();

  async enqueue(message: NewOutboundMessage): Promise<void> {
    if (this.messages.has(message.id)) {
      return;
    }
    this.messages.set(message.id, {
      ...message,
      attempts: 0,
      nextAttemptAt: message.queuedAt,
      lastError: null,
    });
  }

  async list(): Promise<OutboundMessage[]> {
    return [...this.messages.values()].sort((left, right) => left.queuedAt - right.queuedAt);
  }

  async get(id: string): Promise<OutboundMessage | undefined> {
    return this.messages.get(id);
  }

  async remove(id: string): Promise<void> {
    this.messages.delete(id);
  }

  async recordAttempt(id: string, error: string, nextAttemptAt: number): Promise<void> {
    const message = this.messages.get(id);
    if (message === undefined) {
      return;
    }
    this.messages.set(id, {
      ...message,
      attempts: message.attempts + 1,
      nextAttemptAt,
      lastError: error,
    });
  }
}

/** A fresh queue message ID. */
export function newQueueId(): string {
  return randomUUID();
}
