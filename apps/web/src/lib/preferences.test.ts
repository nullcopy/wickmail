import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferences,
  type PreferenceStorage,
} from "./preferences.ts";

class MemoryStorage implements PreferenceStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

test("loadPreferences returns defaults for empty storage", () => {
  assert.deepEqual(loadPreferences(new MemoryStorage()), DEFAULT_PREFERENCES);
});

test("savePreferences round-trips through storage", () => {
  const storage = new MemoryStorage();
  const preferences = {
    defaultLeaseSeconds: null,
    defaultRenewOnOutbound: false,
    expiringSoonSeconds: 86400,
  };
  savePreferences(preferences, storage);
  assert.deepEqual(loadPreferences(storage), preferences);
});

test("loadPreferences coerces invalid values to defaults", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    "wickmail.preferences",
    JSON.stringify({
      defaultLeaseSeconds: "nope",
      defaultRenewOnOutbound: 1,
      expiringSoonSeconds: -5,
    }),
  );
  assert.deepEqual(loadPreferences(storage), DEFAULT_PREFERENCES);
});
