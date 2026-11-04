/**
 * Client-side routing.
 *
 * The app is a single-page application served with an `index.html` fallback,
 * so routing is path-based and the server needs no route table. `matchRoute`
 * is pure so it can be tested without a DOM.
 */

/** A resolved application route. */
export type Route =
  | { name: "dashboard" }
  | { name: "alias"; id: string }
  | { name: "quarantine" }
  | { name: "messages" }
  | { name: "activity" }
  | { name: "settings" }
  | { name: "setup" }
  | { name: "recover" };

/** Resolves a pathname to a route, defaulting unknown paths to the dashboard. */
export function matchRoute(pathname: string): Route {
  const clean = pathname.replace(/\/+$/, "") || "/";
  if (clean === "/") return { name: "dashboard" };
  const alias = /^\/aliases\/([^/]+)$/.exec(clean);
  if (alias) return { name: "alias", id: decodeURIComponent(alias[1]) };
  switch (clean) {
    case "/quarantine":
      return { name: "quarantine" };
    case "/messages":
      return { name: "messages" };
    case "/activity":
      return { name: "activity" };
    case "/settings":
      return { name: "settings" };
    case "/setup":
      return { name: "setup" };
    case "/recover":
      return { name: "recover" };
    default:
      return { name: "dashboard" };
  }
}

/** The URL for an alias detail route. */
export function aliasPath(id: string): string {
  return `/aliases/${encodeURIComponent(id)}`;
}
