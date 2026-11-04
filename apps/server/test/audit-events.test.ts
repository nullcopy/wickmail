import { afterEach, describe, expect, it } from "vitest";
import type { AliasEventType } from "wickmail-core";
import { createAlias } from "../src/alias/repository.js";
import {
  AUDIT_RETENTION_DAYS,
  AuditDetailError,
  DELIVERY_METADATA_RETENTION_DAYS,
  listAuditEvents,
  recordAuditEvent,
} from "../src/audit/events.js";
import type { SqliteDatabase } from "../src/db/database.js";
import { createTestDatabase, NOW } from "./helpers.js";

let db: SqliteDatabase;

afterEach(() => {
  db?.close();
});

function openWithAlias(): string {
  db = createTestDatabase();
  const alias = createAlias(db, {
    address: "green.farm@example.com",
    label: "Example Store",
    createdAt: NOW,
    expiresAt: null,
    leaseDurationSeconds: 3600,
    renewOnOutbound: true,
  });
  return alias.id;
}

const REQUIRED_EVENTS: AliasEventType[] = [
  "created",
  "renewed_by_outbound",
  "extended_manually",
  "expired_derived",
  "recovered",
  "replied_as_alias",
  "disabled",
  "enabled",
];

describe("recordAuditEvent", () => {
  it("records every lifecycle event type in order", () => {
    const aliasId = openWithAlias();
    const allEvents: AliasEventType[] = [
      ...REQUIRED_EVENTS,
      "renewed_manually",
      "expiry_set",
      "expiry_removed",
    ];
    allEvents.forEach((type, index) => {
      recordAuditEvent(db, { aliasId, type, occurredAt: NOW + index });
    });

    const stored = listAuditEvents(db, aliasId);
    expect(stored.map((event) => event.type)).toEqual(allEvents);
    expect(stored.map((event) => event.occurredAt)).toEqual(
      allEvents.map((_, index) => NOW + index),
    );
  });

  it("stores non-content detail", () => {
    const aliasId = openWithAlias();
    recordAuditEvent(db, {
      aliasId,
      type: "expired_derived",
      occurredAt: NOW,
      detail: { expiresAt: NOW, derived: true },
    });
    const [event] = listAuditEvents(db, aliasId);
    expect(event?.detail).toEqual({ expiresAt: NOW, derived: true });
  });

  it("rejects detail that carries a message body", () => {
    const aliasId = openWithAlias();
    for (const key of ["body", "bodyText", "messageBody", "html", "raw", "text"]) {
      expect(() =>
        recordAuditEvent(db, {
          aliasId,
          type: "recovered",
          occurredAt: NOW,
          detail: { [key]: "x" },
        }),
      ).toThrow(AuditDetailError);
    }
    expect(listAuditEvents(db, aliasId)).toHaveLength(0);
  });

  it("rejects an unknown event type", () => {
    const aliasId = openWithAlias();
    expect(() =>
      recordAuditEvent(db, {
        aliasId,
        type: "not_a_real_event" as AliasEventType,
        occurredAt: NOW,
      }),
    ).toThrow();
  });
});

describe("audit retention", () => {
  it("retains audit records longer than delivery metadata", () => {
    expect(AUDIT_RETENTION_DAYS).toBeGreaterThan(DELIVERY_METADATA_RETENTION_DAYS);
  });

  it("keeps message content out of the audit schema", () => {
    openWithAlias();
    const columns = (
      db.prepare("PRAGMA table_info(audit_events)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toEqual(["id", "alias_id", "type", "occurred_at", "detail", "created_at"]);
    expect(columns).not.toContain("subject");
    expect(columns).not.toContain("body");
  });
});
