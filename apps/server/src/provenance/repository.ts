import type { Provenance } from "wickmail-core";
import { updateAlias } from "../alias/repository.js";
import type { SqliteDatabase } from "../db/database.js";

/** Input for recording trusted provenance at acceptance. */
export interface RecordProvenanceInput {
  /** The trusted `X-Wickmail-Message-ID`. */
  messageId: string;
  /** Alias IDs that received the message, in stable order. */
  aliasIds: string[];
  /** Whether the primary address received the message. */
  primaryReceived: boolean;
  /** The envelope recipients, including blind copies. */
  envelopeRecipients: string[];
  /** Acceptance time in epoch milliseconds. */
  createdAt: number;
}

interface ProvenanceRow {
  messageId: string;
  primaryReceived: number;
  envelopeRecipients: string;
}

/**
 * Record the trusted envelope provenance for a message. Provenance is stored
 * as alias IDs plus whether the primary address received the message; envelope
 * recipients are authoritative and include blind copies.
 */
export function recordProvenance(db: SqliteDatabase, input: RecordProvenanceInput): Provenance {
  const envelopeRecipients = [...new Set(input.envelopeRecipients)];
  db.prepare(
    `INSERT INTO message_provenance (message_id, primary_received, envelope_recipients, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (message_id) DO UPDATE SET
       primary_received = excluded.primary_received,
       envelope_recipients = excluded.envelope_recipients`,
  ).run(
    input.messageId,
    input.primaryReceived ? 1 : 0,
    JSON.stringify(envelopeRecipients),
    input.createdAt,
  );

  const link = db.prepare(
    `INSERT OR IGNORE INTO message_provenance_aliases (message_id, alias_id) VALUES (?, ?)`,
  );
  for (const aliasId of input.aliasIds) {
    link.run(input.messageId, aliasId);
  }

  return {
    messageId: input.messageId,
    aliasIds: [...new Set(input.aliasIds)].sort(),
    primaryReceived: input.primaryReceived,
    envelopeRecipients,
  };
}

/** Read the trusted provenance for a message, or undefined. */
export function getProvenance(db: SqliteDatabase, messageId: string): Provenance | undefined {
  const row = db
    .prepare(
      `SELECT message_id AS messageId, primary_received AS primaryReceived,
              envelope_recipients AS envelopeRecipients
       FROM message_provenance WHERE message_id = ?`,
    )
    .get(messageId) as ProvenanceRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  const aliasIds = (
    db
      .prepare(
        `SELECT alias_id AS aliasId FROM message_provenance_aliases
         WHERE message_id = ? ORDER BY alias_id ASC`,
      )
      .all(messageId) as Array<{ aliasId: string }>
  ).map((link) => link.aliasId);

  return {
    messageId: row.messageId,
    aliasIds,
    primaryReceived: row.primaryReceived === 1,
    envelopeRecipients: JSON.parse(row.envelopeRecipients) as string[],
  };
}

/**
 * Record inbound acceptance: store provenance and update `last_inbound_at`
 * for each receiving alias.
 *
 * `last_inbound_at` is informational, so it never bumps `policy_version` and
 * never modifies `expires_at`. Inbound mail cannot extend its own delivery
 * window.
 */
export function recordInboundAcceptance(
  db: SqliteDatabase,
  input: RecordProvenanceInput,
): Provenance {
  const transaction = db.transaction(() => {
    const provenance = recordProvenance(db, input);
    for (const aliasId of input.aliasIds) {
      updateAlias(db, aliasId, { lastInboundAt: input.createdAt, bumpPolicyVersion: false }, {});
    }
    return provenance;
  });
  return transaction();
}
