import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ApiClient, AuthenticatedResponse } from "wickmail-core";
import { csrfTokenHolder } from "./api/client.js";
import { listAllQuarantine } from "./api/collections.js";
import { ApiProvider, useApi, useOnline } from "./api/context.js";
import { Layout } from "./components/Layout.js";
import { ErrorState, LoadingState } from "./components/ui.js";
import { useAsync } from "./hooks/useAsync.js";
import { navigate, useRoute, type Route } from "./lib/router.js";
import { PreferencesProvider } from "./preferences/context.js";
import { ActivityScreen } from "./screens/ActivityScreen.js";
import { AliasDetailScreen } from "./screens/AliasDetailScreen.js";
import { AuthScreen } from "./screens/AuthScreen.js";
import { DashboardScreen } from "./screens/DashboardScreen.js";
import { GenerateDialog } from "./screens/GenerateDialog.js";
import { MessagesScreen } from "./screens/MessagesScreen.js";
import { QuarantineScreen } from "./screens/QuarantineScreen.js";
import { ReplyComposerScreen } from "./screens/ReplyComposerScreen.js";
import { SettingsScreen } from "./screens/SettingsScreen.js";

/** Props for {@link Root}. */
export interface RootProps {
  client: ApiClient;
  /**
   * A preloaded session. Omit it to load the session from the API; pass `null`
   * to render the signed-out state.
   */
  initialSession?: AuthenticatedResponse | null;
}

/** The application root: session loading, authentication, and the app shell. */
export function Root({ client, initialSession }: RootProps): ReactNode {
  const online = useOnline();
  const [session, setSession] = useState<AuthenticatedResponse | null>(initialSession ?? null);
  const [loading, setLoading] = useState(initialSession === undefined);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  const setSessionAndToken = useCallback((next: AuthenticatedResponse | null) => {
    csrfTokenHolder.token = next?.csrfToken ?? null;
    setSession(next);
  }, []);

  useEffect(() => {
    if (initialSession !== undefined) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    client.getSession().then(
      (value) => {
        if (!cancelled) {
          setSessionAndToken(value);
          setLoading(false);
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setError(reason);
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, initialSession, attempt, setSessionAndToken]);

  const value = useMemo(
    () => ({ client, session, setSession: setSessionAndToken, online }),
    [client, session, setSessionAndToken, online],
  );

  return (
    <ApiProvider value={value}>
      <PreferencesProvider>
        {loading ? (
          <LoadingState label="Loading Wickmail…" />
        ) : error !== null ? (
          <ErrorState error={error} onRetry={() => setAttempt((current) => current + 1)} />
        ) : session === null ? (
          <AuthScreen onAuthenticated={setSessionAndToken} />
        ) : (
          <AppShell />
        )}
      </PreferencesProvider>
    </ApiProvider>
  );
}

function renderScreen(route: Route, onGenerate: () => void): ReactNode {
  switch (route.name) {
    case "dashboard":
      return <DashboardScreen onGenerate={onGenerate} />;
    case "alias":
      return <AliasDetailScreen id={route.id} />;
    case "quarantine":
      return <QuarantineScreen />;
    case "messages":
      return <MessagesScreen />;
    case "composer":
      return <ReplyComposerScreen id={route.id} />;
    case "activity":
      return <ActivityScreen />;
    case "settings":
      return <SettingsScreen />;
  }
}

function AppShell(): ReactNode {
  const { client, session, setSession } = useApi();
  const route = useRoute();
  const [generateOpen, setGenerateOpen] = useState(false);
  const quarantine = useAsync(() => listAllQuarantine(client), [client]);
  const quarantinedCount = useMemo(
    () => (quarantine.data ?? []).filter((message) => message.status === "quarantined").length,
    [quarantine.data],
  );

  if (session === null) {
    return null;
  }

  return (
    <Layout
      route={route}
      session={session}
      quarantinedCount={quarantinedCount}
      onGenerate={() => setGenerateOpen(true)}
      onLogout={() => {
        void client
          .logout()
          .catch(() => undefined)
          .finally(() => setSession(null));
      }}
    >
      {renderScreen(route, () => setGenerateOpen(true))}
      <GenerateDialog
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        onCreated={(alias) => {
          setGenerateOpen(false);
          navigate({ name: "alias", id: alias.id });
        }}
      />
    </Layout>
  );
}
