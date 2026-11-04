/**
 * Bridge to the native Android shell.
 *
 * The shell injects `window.wickmailNative` only when the app runs inside the
 * Android WebView, and only for the management origin. In a browser the object
 * is absent and every helper here degrades to a no-op, so the web app keeps
 * working unchanged.
 */

/** App-lock state reported by the native shell. */
export interface NativeAppLockState {
  /** Whether the device can authenticate the user at all. */
  available: boolean;
  /** Whether the user has turned the app lock on. */
  enabled: boolean;
  /** Seconds in the background before the app re-locks. */
  timeoutSeconds: number;
}

/** The operations the Android shell exposes to the web app. */
export interface WickmailNative {
  readonly isAvailable: true;
  copy(text: string): Promise<{ ok: boolean }>;
  share(title: string, text: string): Promise<{ ok: boolean }>;
  getAppLock(): Promise<NativeAppLockState>;
  setAppLock(enabled: boolean): Promise<NativeAppLockState>;
  setLockTimeout(seconds: number): Promise<NativeAppLockState>;
}

declare global {
  interface Window {
    wickmailNative?: WickmailNative;
  }
}

/** The event the shell dispatches when the app receives shared text. */
export const SHARE_EVENT = "wickmail:share";

/** Returns the native bridge when running inside the Android shell. */
export function nativeBridge(): WickmailNative | null {
  if (typeof window === "undefined") return null;
  const bridge = window.wickmailNative;
  return bridge && bridge.isAvailable ? bridge : null;
}

/** Derives a suggested alias label from shared text or a merchant URL. */
export function suggestLabelFromShare(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  try {
    return new URL(trimmed).hostname.replace(/^www\./, "");
  } catch {
    // Not a URL; fall through to the first line.
  }
  const firstLine = trimmed.split(/\r?\n/, 1)[0].trim();
  return firstLine.length > 60 ? firstLine.slice(0, 60) : firstLine;
}
