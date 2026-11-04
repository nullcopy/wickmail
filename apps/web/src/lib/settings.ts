import { DAY_MS } from "./format.js";

/** User preferences for the management app. They are not server state. */
export interface Preferences {
  /** The lease duration used when generating an alias without an explicit choice. */
  defaultLeaseSeconds: number;
  /** The renewal behavior pre-selected when generating an alias. */
  defaultRenewOnOutbound: boolean;
  /** How soon before expiry an alias is counted as expiring soon. */
  expiringSoonMs: number;
}

/** The default preferences. */
export const DEFAULT_PREFERENCES: Preferences = {
  defaultLeaseSeconds: 7 * 24 * 60 * 60,
  defaultRenewOnOutbound: true,
  expiringSoonMs: 7 * DAY_MS,
};

/** The storage key for preferences. It never holds tokens or message data. */
export const PREFERENCES_KEY = "wickmail.preferences";

/** Parse preferences from a JSON string, falling back to defaults. */
export function parsePreferences(raw: string | null): Preferences {
  if (raw === null) {
    return { ...DEFAULT_PREFERENCES };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    const lease = parsed.defaultLeaseSeconds;
    const expiring = parsed.expiringSoonMs;
    return {
      defaultLeaseSeconds:
        typeof lease === "number" && Number.isFinite(lease) && lease > 0
          ? lease
          : DEFAULT_PREFERENCES.defaultLeaseSeconds,
      defaultRenewOnOutbound:
        typeof parsed.defaultRenewOnOutbound === "boolean"
          ? parsed.defaultRenewOnOutbound
          : DEFAULT_PREFERENCES.defaultRenewOnOutbound,
      expiringSoonMs:
        typeof expiring === "number" && Number.isFinite(expiring) && expiring > 0
          ? expiring
          : DEFAULT_PREFERENCES.expiringSoonMs,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Load preferences from browser storage, or the defaults. */
export function loadPreferences(): Preferences {
  if (typeof localStorage === "undefined") {
    return { ...DEFAULT_PREFERENCES };
  }
  return parsePreferences(localStorage.getItem(PREFERENCES_KEY));
}

/** Persist preferences to browser storage. Failures are ignored. */
export function savePreferences(preferences: Preferences): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Storage can be unavailable (private mode, quota); preferences are optional.
  }
}
