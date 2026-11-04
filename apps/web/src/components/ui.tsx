import type { ReactNode } from "react";
import type { AliasState } from "wickmail-core";
import { describeError } from "../lib/errors.js";
import { stateLabel } from "../lib/format.js";

/** A small inline spinner with an accessible label. */
export function Spinner({ label = "Loading" }: { label?: string }): ReactNode {
  return (
    <span className="spinner" role="status" aria-label={label}>
      <span className="spinner-dot" aria-hidden="true" />
      <span className="spinner-dot" aria-hidden="true" />
      <span className="spinner-dot" aria-hidden="true" />
    </span>
  );
}

/** A loading placeholder. */
export function LoadingState({ label = "Loading…" }: { label?: string }): ReactNode {
  return (
    <div className="state state-loading">
      <Spinner label={label} />
      <p>{label}</p>
    </div>
  );
}

/** An empty-state placeholder with an optional action. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="state state-empty">
      <h2>{title}</h2>
      {children !== undefined ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

/** An error state that explains the problem and offers a retry. */
export function ErrorState({
  error,
  onRetry,
  title,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}): ReactNode {
  const described = describeError(error);
  return (
    <div className={`state state-error state-${described.kind}`} role="alert">
      <h2>
        {title ?? (described.kind === "offline" ? "You are offline" : "Something went wrong")}
      </h2>
      <p>{described.message}</p>
      {onRetry !== undefined ? (
        <button type="button" className="button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** A non-blocking notice that the connection is down. */
export function OfflineNotice(): ReactNode {
  return (
    <div className="offline-notice" role="status">
      You are offline. Changes cannot be saved until the connection returns.
    </div>
  );
}

/** An effective-state badge. */
export function StateBadge({ state }: { state: AliasState }): ReactNode {
  return <span className={`badge badge-${state}`}>{stateLabel(state)}</span>;
}

/** A status message, used for mutation results. */
export function StatusMessage({
  tone,
  children,
}: {
  tone: "info" | "success" | "error";
  children: ReactNode;
}): ReactNode {
  return (
    <p className={`status status-${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </p>
  );
}

/** A labelled form field. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint !== undefined ? (
        <p className="field-hint" id={`${htmlFor}-hint`}>
          {hint}
        </p>
      ) : null}
      {error !== undefined ? (
        <p className="field-error" id={`${htmlFor}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
