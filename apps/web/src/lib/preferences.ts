/**
 * Non-sensitive UI preferences.
 *
 * These defaults shape new-alias forms and the dashboard's expiring-soon
 * threshold. They are the only values persisted in browser storage: API
 * tokens, passwords, message bodies, and quarantine metadata are never stored.
 */

/** Persisted UI preferences. */
export interface Preferences {
  /** Default lease for a new alias, or null for no expiry. */
  defaultLeaseSeconds: number | null;
  /** Default outbound-renewal behavior for a new alias. */
  defaultRenewOnOutbound: boolean;
  /** How close to expiry counts as "expiring soon". */
  expiringSoonSeconds: number;
}

/** The built-in defaults. */
export const DEFAULT_PREFERENCES: Preferences = {
  defaultLeaseSeconds: 7 * 24 * 60 * 60,
  defaultRenewOnOutbound: true,
  expiringSoonSeconds: 7 * 24 * 60 * 60,
};

/** Preset lease durations offered when generating an alias. */
export const LEASE_PRESETS: { label: string; seconds: number }[] = [
  { label: "24 hours", seconds: 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { label: "30 days", seconds: 30 * 24 * 60 * 60 },
];

/** Preset thresholds for the expiring-soon count. */
export const THRESHOLD_PRESETS: { label: string; seconds: number }[] = [
  { label: "24 hours", seconds: 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { label: "30 days", seconds: 30 * 24 * 60 * 60 },
];

const STORAGE_KEY = "wickmail.preferences";

/** The subset of `Storage` used for preferences. */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): PreferenceStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function coerce(value: unknown, fallback: Preferences): Preferences {
  if (typeof value !== "object" || value === null) return fallback;
  const record = value as Record<string, unknown>;
  const lease = record["defaultLeaseSeconds"];
  const renew = record["defaultRenewOnOutbound"];
  const threshold = record["expiringSoonSeconds"];
  return {
    defaultLeaseSeconds:
      lease === null || typeof lease === "number"
        ? (lease as number | null)
        : fallback.defaultLeaseSeconds,
    defaultRenewOnOutbound: typeof renew === "boolean" ? renew : fallback.defaultRenewOnOutbound,
    expiringSoonSeconds:
      typeof threshold === "number" && threshold > 0 ? threshold : fallback.expiringSoonSeconds,
  };
}

/** Loads preferences, falling back to the defaults for absent or invalid data. */
export function loadPreferences(storage: PreferenceStorage | null = defaultStorage()): Preferences {
  if (!storage) return { ...DEFAULT_PREFERENCES };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    return coerce(JSON.parse(raw), DEFAULT_PREFERENCES);
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Saves preferences, ignoring storage failures. */
export function savePreferences(
  preferences: Preferences,
  storage: PreferenceStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage may be unavailable; preferences then last only for the session.
  }
}
