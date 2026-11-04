import type { SpooledMessage } from "../spool/types.js";

/**
 * A downstream delivery target. The spool worker retries a message until the
 * target succeeds; a failure never bounces the message.
 */
export interface DeliveryTarget {
  deliver(message: SpooledMessage): Promise<void>;
}

/** A target that records delivered messages; used by tests and dry runs. */
export class RecordingDeliveryTarget implements DeliveryTarget {
  readonly delivered: SpooledMessage[] = [];

  async deliver(message: SpooledMessage): Promise<void> {
    this.delivered.push(message);
  }
}

/** A target that always fails, simulating a downstream outage. */
export class FailingDeliveryTarget implements DeliveryTarget {
  constructor(private readonly error: string = "downstream unavailable") {}

  async deliver(): Promise<void> {
    throw new Error(this.error);
  }
}

/** A target that fails a fixed number of times before succeeding. */
export class FlakyDeliveryTarget implements DeliveryTarget {
  attempts = 0;
  readonly delivered: SpooledMessage[] = [];

  constructor(private readonly failures: number) {}

  async deliver(message: SpooledMessage): Promise<void> {
    this.attempts += 1;
    if (this.attempts <= this.failures) {
      throw new Error(`transient failure ${this.attempts}`);
    }
    this.delivered.push(message);
  }
}
