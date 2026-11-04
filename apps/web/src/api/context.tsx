import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { ApiClient, AuthenticatedResponse } from "wickmail-core";

/** The value shared by every screen. */
export interface ApiContextValue {
  /** The management API client. */
  client: ApiClient;
  /** The current authenticated session, or null when signed out. */
  session: AuthenticatedResponse | null;
  /** Replace the session after sign-in, recovery, or sign-out. */
  setSession: (session: AuthenticatedResponse | null) => void;
  /** Whether the browser reports a connection. */
  online: boolean;
}

const ApiContext = createContext<ApiContextValue | null>(null);

/** Provide the API client and session to the tree. */
export function ApiProvider({
  value,
  children,
}: {
  value: ApiContextValue;
  children: ReactNode;
}): ReactNode {
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

/** Read the API context. */
export function useApi(): ApiContextValue {
  const value = useContext(ApiContext);
  if (value === null) {
    throw new Error("useApi must be used inside an ApiProvider");
  }
  return value;
}

/** Track the browser's online status. */
export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  return online;
}
