import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import type {
  Alias,
  ApiClient,
  AuthenticatedResponse,
  QuarantinedMessage,
  ReplyContext,
} from "wickmail-core";
import { ApiProvider } from "../src/api/context.js";
import { PreferencesProvider } from "../src/preferences/context.js";
import { DEFAULT_PREFERENCES, type Preferences } from "../src/lib/settings.js";

/** A fixed instant used by web tests. */
export const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

/** One day in milliseconds. */
export const DAY_MS = 24 * 60 * 60 * 1000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Build an alias fixture. */
export function makeAlias(overrides: Partial<Alias> = {}): Alias {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    address: "green.farm@example.com",
    label: "Example Store",
    purpose: null,
    state: "active",
    lease: { leaseDurationSeconds: 7 * 24 * 60 * 60, renewOnOutbound: true },
    createdAt: iso(NOW - DAY_MS),
    expiresAt: iso(NOW + 3 * DAY_MS),
    disabledAt: null,
    lastInboundAt: null,
    lastUserActivityAt: null,
    policyVersion: 0,
    ...overrides,
  };
}

/** Build a quarantined message fixture. */
export function makeMessage(overrides: Partial<QuarantinedMessage> = {}): QuarantinedMessage {
  return {
    messageId: "msg-1",
    aliasIds: ["00000000-0000-4000-8000-000000000001"],
    sender: "shop@example.net",
    subject: "Your order shipped",
    receivedAt: iso(NOW - 60 * 60 * 1000),
    quarantineExpiresAt: iso(NOW + 29 * DAY_MS),
    status: "quarantined",
    locator: null,
    ...overrides,
  };
}

/** Build a reply context fixture. */
export function makeReplyContext(overrides: Partial<ReplyContext> = {}): ReplyContext {
  const aliasId = "00000000-0000-4000-8000-000000000001";
  const address = "green.farm@example.com";
  return {
    messageId: "msg-1",
    sender: "shop@example.net",
    subject: "Your order shipped",
    text: "Your order has shipped.",
    originalMessageId: "<abc@example.net>",
    provenance: {
      messageId: "msg-1",
      aliasIds: [aliasId],
      primaryReceived: false,
      envelopeRecipients: [address],
    },
    identity: {
      selection: "default",
      selected: { kind: "alias", aliasId, address },
      options: [
        { kind: "alias", aliasId, address },
        { kind: "primary", address: "me@example.com" },
      ],
    },
    ...overrides,
  };
}

/** Build a session fixture. */
export function makeSession(overrides: Partial<AuthenticatedResponse> = {}): AuthenticatedResponse {
  return {
    user: {
      id: "00000000-0000-4000-8000-0000000000aa",
      username: "admin",
      createdAt: iso(NOW - 30 * DAY_MS),
      updatedAt: iso(NOW - 30 * DAY_MS),
      hasPassword: true,
      passkeyCount: 0,
    },
    session: {
      id: "00000000-0000-4000-8000-0000000000bb",
      createdAt: iso(NOW - DAY_MS),
      expiresAt: iso(NOW + 30 * DAY_MS),
      lastUsedAt: null,
      userAgent: "vitest",
      current: true,
    },
    csrfToken: "csrf-token",
    ...overrides,
  };
}

/**
 * Build a fake API client. Unstubbed methods resolve to `undefined`; pass only
 * the methods a test exercises.
 */
export function createFakeClient(overrides: Record<string, unknown> = {}): ApiClient {
  const fallback = vi.fn(async () => undefined);
  const client = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === "string" && Object.hasOwn(overrides, property)) {
          return overrides[property];
        }
        return fallback;
      },
    },
  );
  return client as unknown as ApiClient;
}

/** Render a screen inside the API and preferences providers. */
export function renderWithApi(
  ui: ReactNode,
  options: {
    client: ApiClient;
    session?: AuthenticatedResponse | null;
    preferences?: Preferences;
  },
): ReturnType<typeof render> {
  const session = options.session === undefined ? makeSession() : options.session;
  return render(
    <ApiProvider
      value={{
        client: options.client,
        session,
        setSession: () => undefined,
        online: true,
      }}
    >
      <PreferencesProvider initial={options.preferences ?? DEFAULT_PREFERENCES}>
        {ui}
      </PreferencesProvider>
    </ApiProvider>,
  );
}
