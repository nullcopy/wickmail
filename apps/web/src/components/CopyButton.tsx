import { useState, type ReactNode } from "react";

/** Copy text to the clipboard, falling back to a hidden textarea. */
export async function copyText(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
    await navigator.clipboard.writeText(value);
    return;
  }
  if (typeof document === "undefined") {
    throw new Error("clipboard is unavailable");
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    const ok = document.execCommand("copy");
    if (!ok) {
      throw new Error("copy command was rejected");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

/** A copy button with an accessible confirmation. */
export function CopyButton({
  value,
  label = "Copy",
  className = "button",
}: {
  value: string;
  label?: string;
  className?: string;
}): ReactNode {
  const [copied, setCopied] = useState(false);

  async function onCopy(): Promise<void> {
    try {
      await copyText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        void onCopy();
      }}
      aria-label={copied ? `${label}: copied` : label}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/** A share button that falls back to copying when the Share API is unavailable. */
export function ShareButton({
  value,
  title = "Wickmail alias",
  className = "button",
}: {
  value: string;
  title?: string;
  className?: string;
}): ReactNode {
  const [shared, setShared] = useState(false);

  async function onShare(): Promise<void> {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title, text: value });
        setShared(true);
        window.setTimeout(() => setShared(false), 2000);
        return;
      } catch {
        // The user cancelled or sharing failed; fall through to copying.
      }
    }
    try {
      await copyText(value);
      setShared(true);
      window.setTimeout(() => setShared(false), 2000);
    } catch {
      setShared(false);
    }
  }

  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        void onShare();
      }}
      aria-label={shared ? "Share: copied" : "Share"}
    >
      {shared ? "Shared" : "Share"}
    </button>
  );
}
