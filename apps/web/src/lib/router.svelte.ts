/**
 * Path-based client-side router.
 *
 * Listens for history navigation and exposes the resolved route reactively.
 */

import { matchRoute, type Route } from "./router";

export { aliasPath } from "./router";

class RouterStore {
  pathname = $state(typeof window === "undefined" ? "/" : window.location.pathname);
  route = $derived<Route>(matchRoute(this.pathname));

  constructor() {
    if (typeof window === "undefined") return;
    window.addEventListener("popstate", () => {
      this.pathname = window.location.pathname;
    });
  }

  /** Pushes a new history entry and updates the active route. */
  navigate(to: string): void {
    if (typeof window === "undefined") return;
    if (to === window.location.pathname) return;
    window.history.pushState({}, "", to);
    this.pathname = window.location.pathname;
    window.scrollTo(0, 0);
  }
}

export const router = new RouterStore();
