import type { DeliveryTarget } from "../delivery/target.js";
import type { Spool } from "./types.js";

/** The default retry backoff: exponential, capped at five minutes. */
export function defaultBackoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 5 * 60 * 1000);
}

/** Options for the spool worker. */
export interface SpoolWorkerOptions {
  /** The current time source. Defaults to `Date.now`. */
  now?: () => number;
  /** The delay before the next attempt, given the attempt count. */
  backoffMs?: (attempts: number) => number;
}

/**
 * Drain the spool to a downstream delivery target. A message is removed only
 * after the target accepts it; a failure records the attempt and schedules a
 * retry, so no accepted message is bounced or dropped.
 */
export class SpoolWorker {
  private readonly now: () => number;
  private readonly backoffMs: (attempts: number) => number;

  constructor(
    private readonly spool: Spool,
    private readonly target: DeliveryTarget,
    options: SpoolWorkerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.backoffMs = options.backoffMs ?? defaultBackoffMs;
  }

  /** Attempt to deliver every message whose next attempt is due. */
  async runOnce(): Promise<{ delivered: number; retried: number }> {
    const now = this.now();
    let delivered = 0;
    let retried = 0;

    for (const message of await this.spool.list()) {
      if (message.nextAttemptAt > now) {
        continue;
      }
      try {
        await this.target.deliver(message);
        await this.spool.remove(message.id);
        delivered += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.spool.recordAttempt(
          message.id,
          reason,
          now + this.backoffMs(message.attempts + 1),
        );
        retried += 1;
      }
    }

    return { delivered, retried };
  }
}
