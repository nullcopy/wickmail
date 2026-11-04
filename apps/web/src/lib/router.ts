import { useEffect, useState } from "react";

/** A hash route in the management app. */
export type Route =
  | { name: "dashboard" }
  | { name: "alias"; id: string }
  | { name: "quarantine" }
  | { name: "messages" }
  | { name: "composer"; id: string }
  | { name: "activity" }
  | { name: "settings" };

/** Parse a `location.hash` value into a route. Unknown routes fall back to the dashboard. */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\//, "");
  const parts = path.split("/").filter((part) => part.length > 0);
  const [first, second, third] = parts;
  if (first === undefined) {
    return { name: "dashboard" };
  }
  if (first === "aliases" && second !== undefined) {
    return { name: "alias", id: decodeURIComponent(second) };
  }
  if (first === "quarantine") {
    return { name: "quarantine" };
  }
  if (first === "messages" && second !== undefined && third === "reply") {
    return { name: "composer", id: decodeURIComponent(second) };
  }
  if (first === "messages") {
    return { name: "messages" };
  }
  if (first === "activity") {
    return { name: "activity" };
  }
  if (first === "settings") {
    return { name: "settings" };
  }
  return { name: "dashboard" };
}

/** Build the `location.hash` value for a route. */
export function routeToHash(route: Route): string {
  switch (route.name) {
    case "dashboard":
      return "#/";
    case "alias":
      return `#/aliases/${encodeURIComponent(route.id)}`;
    case "quarantine":
      return "#/quarantine";
    case "messages":
      return "#/messages";
    case "composer":
      return `#/messages/${encodeURIComponent(route.id)}/reply`;
    case "activity":
      return "#/activity";
    case "settings":
      return "#/settings";
  }
}

/** Navigate to a route. */
export function navigate(route: Route): void {
  if (typeof window === "undefined") {
    return;
  }
  window.location.hash = routeToHash(route);
}

/** The current route, tracked through `hashchange`. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === "undefined" ? { name: "dashboard" } : parseHash(window.location.hash),
  );
  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
