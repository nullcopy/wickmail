import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  ALL_API_SCOPES,
  type ApiScope,
  type CreateApiTokenResponse,
  type RecoveryCodesResponse,
} from "wickmail-core";
import { useApi } from "../api/context.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { CopyButton } from "../components/CopyButton.js";
import { ErrorState, LoadingState, StatusMessage } from "../components/ui.js";
import { useAsync } from "../hooks/useAsync.js";
import { describeError } from "../lib/errors.js";
import { DAY_MS, formatDuration, formatExact } from "../lib/format.js";
import { usePreferences } from "../preferences/context.js";

interface Status {
  tone: "success" | "error" | "info";
  message: string;
}

function PreferencesSection(): ReactNode {
  const { preferences, update } = usePreferences();
  const [leaseSeconds, setLeaseSeconds] = useState(preferences.defaultLeaseSeconds);
  const [renew, setRenew] = useState(preferences.defaultRenewOnOutbound);
  const [thresholdDays, setThresholdDays] = useState(
    Math.round(preferences.expiringSoonMs / DAY_MS),
  );
  const [saved, setSaved] = useState(false);

  return (
    <div className="detail-card">
      <h2>Defaults</h2>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          update({
            defaultLeaseSeconds: leaseSeconds,
            defaultRenewOnOutbound: renew,
            expiringSoonMs: thresholdDays * DAY_MS,
          });
          setSaved(true);
        }}
      >
        <div className="field">
          <label htmlFor="pref-lease">Default lease duration</label>
          <select
            id="pref-lease"
            value={String(leaseSeconds)}
            onChange={(event) => setLeaseSeconds(Number(event.target.value))}
          >
            <option value={String(24 * 60 * 60)}>24 hours</option>
            <option value={String(7 * 24 * 60 * 60)}>7 days</option>
            <option value={String(30 * 24 * 60 * 60)}>30 days</option>
          </select>
        </div>
        <div className="field field-checkbox">
          <input
            id="pref-renew"
            type="checkbox"
            checked={renew}
            onChange={(event) => setRenew(event.target.checked)}
          />
          <label htmlFor="pref-renew">Renew aliases on outbound mail by default</label>
        </div>
        <div className="field">
          <label htmlFor="pref-threshold">Expiring-soon threshold</label>
          <select
            id="pref-threshold"
            value={String(thresholdDays)}
            onChange={(event) => setThresholdDays(Number(event.target.value))}
          >
            <option value="1">1 day</option>
            <option value="3">3 days</option>
            <option value="7">7 days</option>
            <option value="14">14 days</option>
          </select>
        </div>
        {saved ? (
          <StatusMessage tone="success">Preferences saved on this device.</StatusMessage>
        ) : null}
        <div className="row-actions">
          <button type="submit" className="button button-primary">
            Save preferences
          </button>
        </div>
      </form>
    </div>
  );
}

function PasswordSection(): ReactNode {
  const { client } = useApi();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      await client.changePassword({ currentPassword, newPassword });
      setStatus({ tone: "success", message: "Password changed." });
      setCurrentPassword("");
      setNewPassword("");
    } catch (error) {
      setStatus({ tone: "error", message: describeError(error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="detail-card">
      <h2>Password</h2>
      <form className="form" onSubmit={(event) => void onSubmit(event)}>
        <div className="field">
          <label htmlFor="pw-current">Current password</label>
          <input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="pw-new">New password</label>
          <input
            id="pw-new"
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            required
          />
          <p className="field-hint">At least 12 characters.</p>
        </div>
        {status !== null ? (
          <StatusMessage tone={status.tone}>{status.message}</StatusMessage>
        ) : null}
        <div className="row-actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            Change password
          </button>
        </div>
      </form>
    </div>
  );
}

function RecoveryCodesSection(): ReactNode {
  const { client } = useApi();
  const [codes, setCodes] = useState<RecoveryCodesResponse | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  async function regenerate(): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      const response = await client.createRecoveryCodes();
      setCodes(response);
      setStatus({ tone: "success", message: "New recovery codes generated. Save them now." });
    } catch (error) {
      setStatus({ tone: "error", message: describeError(error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="detail-card">
      <h2>Recovery codes</h2>
      <p className="muted">Generating new codes invalidates the previous set.</p>
      {status !== null ? <StatusMessage tone={status.tone}>{status.message}</StatusMessage> : null}
      {codes !== null ? (
        <div className="secret">
          <pre>{codes.codes.join("\n")}</pre>
          <CopyButton value={codes.codes.join("\n")} label="Copy codes" />
        </div>
      ) : null}
      <div className="row-actions">
        <button type="button" className="button" disabled={busy} onClick={() => void regenerate()}>
          Generate recovery codes
        </button>
      </div>
    </div>
  );
}

function SessionsSection(): ReactNode {
  const { client } = useApi();
  const sessions = useAsync(() => client.listSessions(), [client]);
  const [pending, setPending] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  async function revoke(id: string): Promise<void> {
    setPending(null);
    try {
      await client.revokeSession(id);
      setStatus({ tone: "success", message: "Session revoked." });
      sessions.reload();
    } catch (error) {
      setStatus({ tone: "error", message: describeError(error).message });
    }
  }

  return (
    <div className="detail-card">
      <h2>Sessions</h2>
      {status !== null ? <StatusMessage tone={status.tone}>{status.message}</StatusMessage> : null}
      {sessions.loading ? (
        <LoadingState label="Loading sessions…" />
      ) : sessions.error !== null ? (
        <ErrorState error={sessions.error} onRetry={sessions.reload} />
      ) : (
        <ul className="plain-list">
          {(sessions.data?.sessions ?? []).map((session) => (
            <li key={session.id}>
              <span>
                {session.userAgent ?? "Unknown device"}
                {session.current ? " (this session)" : ""}
              </span>
              <span className="muted">Expires {formatExact(session.expiresAt)}</span>
              {!session.current ? (
                <button
                  type="button"
                  className="button button-danger"
                  onClick={() => setPending(session.id)}
                >
                  Revoke
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={pending !== null}
        title="Revoke this session?"
        destructive
        confirmLabel="Revoke session"
        description={<p>The device will be signed out immediately.</p>}
        onConfirm={() => {
          if (pending !== null) void revoke(pending);
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

function ApiTokensSection(): ReactNode {
  const { client } = useApi();
  const tokens = useAsync(() => client.listApiTokens(), [client]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiScope[]>(["aliases:read"]);
  const [created, setCreated] = useState<CreateApiTokenResponse | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  async function create(event: FormEvent): Promise<void> {
    event.preventDefault();
    setStatus(null);
    try {
      const response = await client.createApiToken({ name: name.trim(), scopes });
      setCreated(response);
      setName("");
      tokens.reload();
    } catch (error) {
      setStatus({ tone: "error", message: describeError(error).message });
    }
  }

  async function revoke(id: string): Promise<void> {
    setPending(null);
    try {
      await client.revokeApiToken(id);
      setStatus({ tone: "success", message: "Token revoked." });
      tokens.reload();
    } catch (error) {
      setStatus({ tone: "error", message: describeError(error).message });
    }
  }

  function toggleScope(scope: ApiScope): void {
    setScopes((current) =>
      current.includes(scope) ? current.filter((value) => value !== scope) : [...current, scope],
    );
  }

  return (
    <div className="detail-card">
      <h2>API tokens</h2>
      <p className="muted">Tokens are shown once and never stored in this browser.</p>
      {status !== null ? <StatusMessage tone={status.tone}>{status.message}</StatusMessage> : null}
      {created !== null ? (
        <div className="secret">
          <p>Copy this token now. It will not be shown again.</p>
          <pre>{created.secret}</pre>
          <CopyButton value={created.secret} label="Copy token" />
        </div>
      ) : null}
      {tokens.loading ? (
        <LoadingState label="Loading tokens…" />
      ) : tokens.error !== null ? (
        <ErrorState error={tokens.error} onRetry={tokens.reload} />
      ) : (
        <ul className="plain-list">
          {(tokens.data?.tokens ?? []).map((token) => (
            <li key={token.id}>
              <span>{token.name}</span>
              <span className="muted">{token.scopes.join(", ")}</span>
              <span className="muted">{token.revokedAt === null ? "Active" : "Revoked"}</span>
              {token.revokedAt === null ? (
                <button
                  type="button"
                  className="button button-danger"
                  onClick={() => setPending(token.id)}
                >
                  Revoke
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <form className="form" onSubmit={(event) => void create(event)}>
        <div className="field">
          <label htmlFor="token-name">New token name</label>
          <input
            id="token-name"
            type="text"
            value={name}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <fieldset className="field field-group">
          <legend>Scopes</legend>
          {ALL_API_SCOPES.map((scope) => (
            <label key={scope} className="checkbox">
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={() => toggleScope(scope)}
              />
              <span>{scope}</span>
            </label>
          ))}
        </fieldset>
        <div className="row-actions">
          <button type="submit" className="button button-primary" disabled={scopes.length === 0}>
            Create token
          </button>
        </div>
      </form>
      <ConfirmDialog
        open={pending !== null}
        title="Revoke this token?"
        destructive
        confirmLabel="Revoke token"
        description={<p>Any client using this token loses access immediately.</p>}
        onConfirm={() => {
          if (pending !== null) void revoke(pending);
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

function MailCredentialSection(): ReactNode {
  const { client } = useApi();
  const credential = useAsync(() => client.getMailCredential(), [client]);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  async function rotate(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      await client.rotateMailCredential({ password });
      setPassword("");
      setStatus({ tone: "success", message: "Mail credential rotated." });
      credential.reload();
    } catch (error) {
      setStatus({ tone: "error", message: describeError(error).message });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(): Promise<void> {
    setPending(false);
    try {
      await client.revokeMailCredential();
      setStatus({ tone: "success", message: "Mail credential revoked." });
      credential.reload();
    } catch (error) {
      setStatus({ tone: "error", message: describeError(error).message });
    }
  }

  return (
    <div className="detail-card">
      <h2>Mail credential</h2>
      <p className="muted">
        This is the IMAP and submission password, separate from your management password.
      </p>
      {status !== null ? <StatusMessage tone={status.tone}>{status.message}</StatusMessage> : null}
      {credential.loading ? (
        <LoadingState label="Loading credential…" />
      ) : credential.error !== null ? (
        <ErrorState error={credential.error} onRetry={credential.reload} />
      ) : (
        <p>
          Status:{" "}
          {credential.data?.credential == null
            ? "Not configured"
            : `Configured, rotated ${formatExact(credential.data.credential.rotatedAt)}`}
        </p>
      )}
      <form className="form" onSubmit={(event) => void rotate(event)}>
        <div className="field">
          <label htmlFor="mail-password">New mail password</label>
          <input
            id="mail-password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <p className="field-hint">At least 12 characters.</p>
        </div>
        <div className="row-actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            Rotate credential
          </button>
          <button type="button" className="button button-danger" onClick={() => setPending(true)}>
            Revoke credential
          </button>
        </div>
      </form>
      <ConfirmDialog
        open={pending}
        title="Revoke the mail credential?"
        destructive
        confirmLabel="Revoke credential"
        description={
          <p>Mail clients using this credential will stop working until it is rotated again.</p>
        }
        onConfirm={() => void revoke()}
        onCancel={() => setPending(false)}
      />
    </div>
  );
}

function PasskeysSection(): ReactNode {
  const { client } = useApi();
  const passkeys = useAsync(() => client.listPasskeys(), [client]);
  const [pending, setPending] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  async function remove(id: string): Promise<void> {
    setPending(null);
    try {
      await client.deletePasskey(id);
      setStatus({ tone: "success", message: "Passkey removed." });
      passkeys.reload();
    } catch (error) {
      setStatus({ tone: "error", message: describeError(error).message });
    }
  }

  return (
    <div className="detail-card">
      <h2>Passkeys</h2>
      {status !== null ? <StatusMessage tone={status.tone}>{status.message}</StatusMessage> : null}
      {passkeys.loading ? (
        <LoadingState label="Loading passkeys…" />
      ) : passkeys.error !== null ? (
        <ErrorState error={passkeys.error} onRetry={passkeys.reload} />
      ) : (passkeys.data?.passkeys.length ?? 0) === 0 ? (
        <p className="muted">No passkeys registered.</p>
      ) : (
        <ul className="plain-list">
          {(passkeys.data?.passkeys ?? []).map((passkey) => (
            <li key={passkey.id}>
              <span>{passkey.name ?? "Unnamed passkey"}</span>
              <span className="muted">Added {formatExact(passkey.createdAt)}</span>
              <button
                type="button"
                className="button button-danger"
                onClick={() => setPending(passkey.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={pending !== null}
        title="Remove this passkey?"
        destructive
        confirmLabel="Remove passkey"
        description={<p>The passkey can no longer be used to sign in.</p>}
        onConfirm={() => {
          if (pending !== null) void remove(pending);
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

function ServerInfoSection(): ReactNode {
  const { session } = useApi();
  const { preferences } = usePreferences();
  const [credentialConfigured, setCredentialConfigured] = useState<boolean | null>(null);
  const { client } = useApi();

  useEffect(() => {
    let cancelled = false;
    client.getMailCredential().then(
      (response) => {
        if (!cancelled) setCredentialConfigured(response.credential !== null);
      },
      () => {
        if (!cancelled) setCredentialConfigured(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <div className="detail-card">
      <h2>Server information</h2>
      <dl className="info-list">
        <div>
          <dt>Management API</dt>
          <dd>{origin || "same origin"}</dd>
        </div>
        <div>
          <dt>API version</dt>
          <dd>v1</dd>
        </div>
        <div>
          <dt>Signed in as</dt>
          <dd>{session?.user.username ?? ""}</dd>
        </div>
        <div>
          <dt>Session expires</dt>
          <dd>{session === null ? "" : formatExact(session.session.expiresAt)}</dd>
        </div>
        <div>
          <dt>Mail credential</dt>
          <dd>
            {credentialConfigured === null
              ? "Unknown"
              : credentialConfigured
                ? "Configured"
                : "Not configured"}
          </dd>
        </div>
        <div>
          <dt>Default lease</dt>
          <dd>{formatDuration(preferences.defaultLeaseSeconds)}</dd>
        </div>
      </dl>
    </div>
  );
}

/** The settings screen: preferences, credentials, tokens, sessions, and server info. */
export function SettingsScreen(): ReactNode {
  return (
    <section className="screen" aria-labelledby="settings-title">
      <div className="screen-header">
        <h1 id="settings-title">Settings</h1>
      </div>
      <div className="settings-grid">
        <PreferencesSection />
        <ServerInfoSection />
        <PasswordSection />
        <RecoveryCodesSection />
        <SessionsSection />
        <ApiTokensSection />
        <MailCredentialSection />
        <PasskeysSection />
      </div>
    </section>
  );
}
