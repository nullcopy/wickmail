import type {
  AliasEvent,
  AliasEventType,
  AliasLeaseRequest,
  CreateAliasRequest,
} from "wickmail-core";

/** The lease presets offered when generating an alias. */
export type LeasePreset = "24h" | "7d" | "30d" | "none" | "custom";

/** A selectable lease preset. */
export interface LeasePresetOption {
  value: LeasePreset;
  label: string;
  /** The duration in seconds, or null for no-expiry and custom presets. */
  seconds: number | null;
}

/** The default lease duration: seven days. */
export const DEFAULT_LEASE_SECONDS = 7 * 24 * 60 * 60;

/** The lease presets, in display order. */
export const LEASE_PRESETS: readonly LeasePresetOption[] = [
  { value: "24h", label: "24 hours", seconds: 24 * 60 * 60 },
  { value: "7d", label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { value: "30d", label: "30 days", seconds: 30 * 24 * 60 * 60 },
  { value: "none", label: "No expiry", seconds: null },
  { value: "custom", label: "Custom date…", seconds: null },
];

/** The inputs for the generate flow. */
export interface GenerateOptions {
  label: string;
  purpose: string;
  preset: LeasePreset;
  /** A `datetime-local` value, used only for the custom preset. */
  customExpiresAt: string;
  renewOnOutbound: boolean;
}

/** The default generate inputs. */
export function defaultGenerateOptions(): GenerateOptions {
  return {
    label: "",
    purpose: "",
    preset: "7d",
    customExpiresAt: "",
    renewOnOutbound: true,
  };
}

/** Convert a preset into a lease request. */
export function leaseForPreset(
  preset: LeasePreset,
  customExpiresAt: string,
  _now: number,
): AliasLeaseRequest {
  switch (preset) {
    case "24h":
      return { type: "duration", durationSeconds: 24 * 60 * 60 };
    case "7d":
      return { type: "duration", durationSeconds: 7 * 24 * 60 * 60 };
    case "30d":
      return { type: "duration", durationSeconds: 30 * 24 * 60 * 60 };
    case "none":
      return { type: "none" };
    case "custom": {
      const parsed = new Date(customExpiresAt);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error("Enter a valid custom expiration time.");
      }
      return { type: "absolute", expiresAt: parsed.toISOString() };
    }
  }
}

/**
 * Build the `POST /v1/aliases` request. It never carries an address or local
 * part: the server generates the readable address and returns it only after
 * the alias is stored.
 */
export function buildCreateAliasRequest(options: GenerateOptions, now: number): CreateAliasRequest {
  const label = options.label.trim();
  if (label.length === 0) {
    throw new Error("Enter a label for the alias.");
  }
  const purpose = options.purpose.trim();
  return {
    label,
    purpose: purpose.length > 0 ? purpose : null,
    lease: leaseForPreset(options.preset, options.customExpiresAt, now),
    renewOnOutbound: options.renewOnOutbound,
  };
}

/** Validate the generate inputs, returning an error message or null. */
export function validateGenerateOptions(options: GenerateOptions, now: number): string | null {
  if (options.label.trim().length === 0) {
    return "Enter a label for the alias.";
  }
  if (options.preset === "custom") {
    const parsed = new Date(options.customExpiresAt);
    if (Number.isNaN(parsed.getTime())) {
      return "Enter a custom expiration time.";
    }
    if (parsed.getTime() <= now) {
      return "The custom expiration time must be in the future.";
    }
  }
  return null;
}

const EVENT_LABELS: Record<AliasEventType, string> = {
  created: "Created",
  renewed_by_outbound: "Renewed by outbound mail",
  renewed_manually: "Manually renewed",
  extended_manually: "Manually extended",
  expiry_set: "Expiry set",
  expiry_removed: "Expiry removed",
  expired_derived: "Expired",
  recovered: "Message recovered",
  replied_as_alias: "Replied as alias",
  disabled: "Disabled",
  enabled: "Enabled",
};

/** A human label for a lifecycle event type. */
export function eventLabel(type: AliasEventType): string {
  return EVENT_LABELS[type];
}

/** A human label for a lifecycle event, including a compact detail summary. */
export function describeEvent(event: AliasEvent): string {
  const label = eventLabel(event.type);
  const detail = event.detail;
  if (detail === null) {
    return label;
  }
  const expiresAt = detail["expiresAt"];
  if (typeof expiresAt === "string") {
    return `${label} — expires ${expiresAt}`;
  }
  const messageId = detail["messageId"];
  if (typeof messageId === "string") {
    return `${label} — ${messageId}`;
  }
  return label;
}
