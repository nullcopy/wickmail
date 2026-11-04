import type { ReactNode } from "react";
import type { AuthenticatedResponse } from "wickmail-core";
import { routeToHash, type Route } from "../lib/router.js";

interface NavItem {
  label: string;
  hash: string;
  routeName: Route["name"];
}

const NAV_ITEMS: readonly NavItem[] = [
  { label: "Dashboard", hash: "#/", routeName: "dashboard" },
  { label: "Quarantine", hash: "#/quarantine", routeName: "quarantine" },
  { label: "Messages", hash: "#/messages", routeName: "messages" },
  { label: "Activity", hash: "#/activity", routeName: "activity" },
  { label: "Settings", hash: "#/settings", routeName: "settings" },
];

/** Props for {@link Layout}. */
export interface LayoutProps {
  route: Route;
  session: AuthenticatedResponse;
  quarantinedCount: number;
  onGenerate: () => void;
  onLogout: () => void;
  children: ReactNode;
}

/** The application shell: header, primary navigation, and content area. */
export function Layout({
  route,
  session,
  quarantinedCount,
  onGenerate,
  onLogout,
  children,
}: LayoutProps): ReactNode {
  const activeRoute = route.name === "alias" ? "dashboard" : route.name;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ✉
          </span>
          <span className="brand-name">Wickmail</span>
        </div>
        <button type="button" className="button button-primary" onClick={onGenerate}>
          Generate alias
        </button>
        <div className="header-user">
          <span className="header-username" title={session.user.username}>
            {session.user.username}
          </span>
          <button type="button" className="button button-quiet" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </header>
      <nav className="app-nav" aria-label="Primary">
        <ul>
          {NAV_ITEMS.map((item) => (
            <li key={item.hash}>
              <a
                href={routeToHash({ name: item.routeName } as Route)}
                aria-current={activeRoute === item.routeName ? "page" : undefined}
              >
                {item.label}
                {item.routeName === "quarantine" && quarantinedCount > 0 ? (
                  <span className="nav-count" aria-label={`${quarantinedCount} quarantined`}>
                    {quarantinedCount}
                  </span>
                ) : null}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" className="app-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
