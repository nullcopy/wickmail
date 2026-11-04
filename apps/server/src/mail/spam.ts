import { getHeader } from "./headers.js";

/**
 * Classify a message as spam from the headers a spam filter adds before the
 * proxy. The proxy uses this only to choose the trusted route; it never
 * rewrites or rejects the message.
 *
 * `X-Spam-Flag: YES` and `X-Spam-Status: Yes` are the conventional signals set
 * by Rspamd and compatible filters.
 */
export function isSpam(raw: string): boolean {
  const flag = getHeader(raw, "X-Spam-Flag");
  if (flag !== undefined && flag.trim().toLowerCase() === "yes") {
    return true;
  }
  const status = getHeader(raw, "X-Spam-Status");
  if (status !== undefined) {
    const verdict = status.split(/[;,]/)[0]?.trim().toLowerCase();
    if (verdict === "yes") {
      return true;
    }
  }
  return false;
}
