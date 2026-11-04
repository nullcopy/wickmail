import type { DeliveryTarget } from "./target.js";
import { LmtpClient } from "../lmtp/client.js";
import type { SpooledMessage } from "../spool/types.js";

/** A delivery target that forwards to a downstream LMTP server such as Dovecot. */
export class LmtpDeliveryTarget implements DeliveryTarget {
  constructor(private readonly client: LmtpClient) {}

  async deliver(message: SpooledMessage): Promise<void> {
    await this.client.deliver({
      mailFrom: message.mailFrom,
      rcptTo: message.rcptTo,
      data: message.raw,
    });
  }
}
