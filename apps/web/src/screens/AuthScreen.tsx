import { useState, type FormEvent, type ReactNode } from "react";
import type { AuthenticatedResponse } from "wickmail-core";
import { useApi } from "../api/context.js";
import { CopyButton } from "../components/CopyButton.js";
import { StatusMessage } from "../components/ui.js";
import { describeError } from "../lib/errors.js";

type Mode = "login" | "setup" | "recover";

interface PendingSetup {
  session: AuthenticatedResponse;
  recoveryCodes: string[];
}

/** The sign-in, first-run setup, and recovery screen. */
export function AuthScreen({
  onAuthenticated,
}: {
  onAuthenticated: (session: AuthenticatedResponse) => void;
}): ReactNode {
  const { client } = useApi();
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingSetup | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        const response = await client.login({ username, password });
        onAuthenticated(response);
      } else if (mode === "setup") {
        const response = await client.setup({
          token,
          password: newPassword,
          ...(username.trim().length > 0 ? { username: username.trim() } : {}),
        });
        setPending({ session: response, recoveryCodes: response.recoveryCodes });
      } else {
        const response = await client.recoverAccount({ code, newPassword });
        setPending({ session: response, recoveryCodes: response.recoveryCodes });
      }
    } catch (reason) {
      setError(describeError(reason).message);
    } finally {
      setBusy(false);
    }
  }

  if (pending !== null) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>Save your recovery codes</h1>
          <p className="muted">
            These codes are shown once. Store them somewhere safe; they are the only way to recover
            the account without a mail client.
          </p>
          <div className="secret">
            <pre>{pending.recoveryCodes.join("\n")}</pre>
            <CopyButton value={pending.recoveryCodes.join("\n")} label="Copy codes" />
          </div>
          <button
            type="button"
            className="button button-primary"
            onClick={() => onAuthenticated(pending.session)}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Wickmail</h1>
        {mode === "login" ? (
          <form className="form" onSubmit={(event) => void submit(event)}>
            <div className="field">
              <label htmlFor="auth-username">Username</label>
              <input
                id="auth-username"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="auth-password">Password</label>
              <input
                id="auth-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            {error !== null ? <StatusMessage tone="error">{error}</StatusMessage> : null}
            <button type="submit" className="button button-primary" disabled={busy}>
              Sign in
            </button>
            <div className="auth-links">
              <button type="button" className="link" onClick={() => setMode("setup")}>
                First-time setup
              </button>
              <button type="button" className="link" onClick={() => setMode("recover")}>
                Use a recovery code
              </button>
            </div>
          </form>
        ) : (
          <form className="form" onSubmit={(event) => void submit(event)}>
            {mode === "setup" ? (
              <div className="field">
                <label htmlFor="auth-token">Setup token</label>
                <input
                  id="auth-token"
                  type="text"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  required
                />
                <p className="field-hint">Printed by the local bootstrap command.</p>
              </div>
            ) : (
              <div className="field">
                <label htmlFor="auth-code">Recovery code</label>
                <input
                  id="auth-code"
                  type="text"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                />
              </div>
            )}
            {mode === "setup" ? (
              <div className="field">
                <label htmlFor="auth-new-user">Username (optional)</label>
                <input
                  id="auth-new-user"
                  type="text"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="auth-new-password">New password</label>
              <input
                id="auth-new-password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
              />
              <p className="field-hint">At least 12 characters.</p>
            </div>
            {error !== null ? <StatusMessage tone="error">{error}</StatusMessage> : null}
            <button type="submit" className="button button-primary" disabled={busy}>
              {mode === "setup" ? "Create account" : "Recover account"}
            </button>
            <div className="auth-links">
              <button type="button" className="link" onClick={() => setMode("login")}>
                Back to sign in
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
