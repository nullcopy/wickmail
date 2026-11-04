import { createContext, useContext, useState, type ReactNode } from "react";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferences,
  type Preferences,
} from "../lib/settings.js";

/** The value shared by screens that read or edit preferences. */
export interface PreferencesContextValue {
  preferences: Preferences;
  update: (patch: Partial<Preferences>) => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

/** Provide user preferences, persisted to browser storage. */
export function PreferencesProvider({
  children,
  initial,
}: {
  children: ReactNode;
  initial?: Preferences;
}): ReactNode {
  const [preferences, setPreferences] = useState<Preferences>(() => initial ?? loadPreferences());
  return (
    <PreferencesContext.Provider
      value={{
        preferences,
        update: (patch) => {
          setPreferences((current) => {
            const next = { ...current, ...patch };
            savePreferences(next);
            return next;
          });
        },
      }}
    >
      {children}
    </PreferencesContext.Provider>
  );
}

/** Read user preferences. */
export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext);
  if (value === null) {
    return {
      preferences: DEFAULT_PREFERENCES,
      update: () => undefined,
    };
  }
  return value;
}
