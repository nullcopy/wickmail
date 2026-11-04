/**
 * Builders for the web app's pure-logic tests.
 *
 * These mirror the server contract shapes but are not part of the app bundle.
 */

import type {
  Alias,
  Message,
  MessageRoute,
  QuarantineResponse,
  ReplyContext,
} from "@wickmail/core";

/** Builds an alias with sensible defaults. */
export function makeAlias(overrides: Partial<Alias> = {}): Alias {
  return {
    id: "018f9b60-0000-7000-8000-000000000001",
    address: "green.farm@example.com",
    label: "Example Store",
    purpose: null,
    state: "active",
    createdAt: "2026-01-01T00:00:00Z",
    expiresAt: "2026-01-08T00:00:00Z",
    disabledAt: null,
    leaseSeconds: 604800,
    renewOnOutbound: true,
    lastInboundAt: null,
    lastUserActivityAt: null,
    lastUsedAt: "2026-01-01T00:00:00Z",
    policyVersion: 1,
    ...overrides,
  };
}

/** Builds a message with sensible defaults. */
export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    messageId: "018f9b60-0000-7000-8000-0000000000aa",
    aliasIds: ["018f9b60-0000-7000-8000-000000000001"],
    primaryReceived: false,
    sender: "store@example.com",
    subject: "Your order",
    receivedAt: "2026-01-04T00:00:00Z",
    route: "inbox" as MessageRoute,
    ...overrides,
  };
}

/** Builds a quarantine entry with sensible defaults. */
export function makeQuarantine(overrides: Partial<QuarantineResponse> = {}): QuarantineResponse {
  return {
    messageId: "018f9b60-0000-7000-8000-0000000000aa",
    kind: "lease",
    status: "quarantined",
    aliasIds: ["018f9b60-0000-7000-8000-000000000001"],
    sender: "store@example.com",
    subject: "Your order",
    receivedAt: "2026-01-04T00:00:00Z",
    quarantineExpiresAt: "2026-02-03T00:00:00Z",
    sizeBytes: 1024,
    deleteReason: null,
    createdAt: "2026-01-04T00:00:00Z",
    updatedAt: "2026-01-04T00:00:00Z",
    recoveredAt: null,
    deletedAt: null,
    preview: null,
    ...overrides,
  };
}

/** Builds a reply context with sensible defaults. */
export function makeReplyContext(overrides: Partial<ReplyContext> = {}): ReplyContext {
  return {
    messageId: "018f9b60-0000-7000-8000-0000000000aa",
    from: "store@example.com",
    subject: "Your order",
    text: "Your order shipped.",
    originalMessageId: "<orig@example.com>",
    provenance: {
      aliasIds: ["018f9b60-0000-7000-8000-000000000001"],
      primaryReceived: false,
    },
    identity: {
      selection: "default",
      selected: {
        kind: "alias",
        aliasId: "018f9b60-0000-7000-8000-000000000001",
        address: "green.farm@example.com",
      },
      options: [
        {
          kind: "alias",
          aliasId: "018f9b60-0000-7000-8000-000000000001",
          address: "green.farm@example.com",
        },
        { kind: "primary", address: "user@example.com" },
      ],
    },
    ...overrides,
  };
}
