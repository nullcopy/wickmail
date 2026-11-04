import type { Alias, ApiClient, QuarantinedMessage } from "wickmail-core";
import { ALIAS_PAGE_SIZE } from "../lib/aliases.js";

/** The maximum number of pages fetched while collecting a full list. */
const MAX_PAGES = 50;

/** Fetch every alias owned by the user, following pagination cursors. */
export async function listAllAliases(client: ApiClient): Promise<Alias[]> {
  const aliases: Alias[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await client.listAliases(
      cursor === null ? { limit: ALIAS_PAGE_SIZE } : { limit: ALIAS_PAGE_SIZE, cursor },
    );
    aliases.push(...response.aliases);
    if (response.nextCursor === null) {
      break;
    }
    cursor = response.nextCursor;
  }
  return aliases;
}

/** Fetch every quarantined message visible to the user, following cursors. */
export async function listAllQuarantine(client: ApiClient): Promise<QuarantinedMessage[]> {
  const messages: QuarantinedMessage[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await client.listQuarantine(cursor === null ? {} : { cursor });
    messages.push(...response.messages);
    if (response.nextCursor === null) {
      break;
    }
    cursor = response.nextCursor;
  }
  return messages;
}
