import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useApi } from "../api/context.js";
import { listAllQuarantine } from "../api/collections.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { CopyButton, ShareButton, copyText } from "../components/CopyButton.js";
import { QuarantineActionDialogs } from "../components/QuarantineDialogs.js";
import { QuarantineTable } from "../components/QuarantineTable.js";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  OfflineNotice,
  StateBadge,
  StatusMessage,
} from "../components/ui.js";
import { useAsync } from "../hooks/useAsync.js";
import { useQuarantineActions, type ActionStatus } from "../hooks/useQuarantineActions.js";
import { describeError } from "../lib/errors.js";
import { describeEvent } from "../lib/generate.js";
import { describeRenewal, describeState, formatExact, formatRelativeTime } from "../lib/format.js";
import { navigate } from "../lib/router.js";

const DURATION_OPTIONS = [
  { value: "", label: "Default duration" },
  { value: "86400", label: "24 hours" },
  { value: "604800", label: "7 days" },
  { value: "2592000", label: "30 days" },
];

/** The alias detail screen: state, policy, actions, messages, and events. */
export function AliasDetailScreen({ id }: { id: string }): ReactNode {
  const { client, online } = useApi();
  const [reloadKey, setReloadKey] = useState(0);
  const reload = (): void => setReloadKey((value) => value + 1);

  const alias = useAsync(() => client.getAlias(id), [client, id, reloadKey]);
  const events = useAsync(() => client.listAliasEvents(id), [client, id, reloadKey]);
  const messages = useAsync(
    () => listAllQuarantine(client).then((all) => all.filter((m) => m.aliasIds.includes(id))),
    [client, id, reloadKey],
  );
  const actions = useQuarantineActions(reload);

  const [label, setLabel] = useState("");
  const [purpose, setPurpose] = useState("");
  const [renewOnOutbound, setRenewOnOutbound] = useState(true);
  const [duration, setDuration] = useState("");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [editStatus, setEditStatus] = useState<ActionStatus | null>(null);
  const [actionStatus, setActionStatus] = useState<ActionStatus | null>(null);

  const current = alias.data?.alias ?? null;

  useEffect(() => {
    if (current !== null) {
      setLabel(current.label);
      setPurpose(current.purpose ?? "");
      setRenewOnOutbound(current.lease.renewOnOutbound);
    }
  }, [current]);

  const addressMap = useMemo(() => {
    const map = new Map<string, string>();
    if (current !== null) {
      map.set(current.id, current.address);
    }
    return map;
  }, [current]);

  const durationBody = duration === "" ? {} : { durationSeconds: Number(duration) };

  async function runAction(label: string, operation: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setActionStatus(null);
    try {
      await operation();
      setActionStatus({ tone: "success", message: label });
      reload();
      return true;
    } catch (error) {
      setActionStatus({ tone: "error", message: describeError(error).message });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function renewAndCopy(): Promise<void> {
    const ok = await runAction("Renewed the alias.", () => client.renewAlias(id, durationBody));
    if (ok && current !== null) {
      try {
        await copyText(current.address);
        setActionStatus({ tone: "success", message: "Renewed and copied the address." });
      } catch {
        setActionStatus({ tone: "info", message: "Renewed. Copy the address below." });
      }
    }
  }

  async function savePolicy(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (current === null) {
      return;
    }
    setSaving(true);
    setEditStatus(null);
    try {
      await client.updateAlias(id, {
        label: label.trim(),
        purpose: purpose.trim().length > 0 ? purpose.trim() : null,
        renewOnOutbound,
        policyVersion: current.policyVersion,
      });
      setEditStatus({ tone: "success", message: "Saved." });
      reload();
    } catch (error) {
      const described = describeError(error);
      setEditStatus({
        tone: "error",
        message:
          described.kind === "conflict"
            ? "This alias changed elsewhere. The latest values are reloaded; review and save again."
            : described.message,
      });
      if (described.kind === "conflict") {
        reload();
      }
    } finally {
      setSaving(false);
    }
  }

  if (alias.loading) {
    return <LoadingState label="Loading alias…" />;
  }
  if (alias.error !== null) {
    return <ErrorState error={alias.error} onRetry={alias.reload} />;
  }
  if (current === null) {
    return <EmptyState title="Alias not found" />;
  }

  const now = Date.now();
  const quarantined = (messages.data ?? []).filter((message) => message.status === "quarantined");

  return (
    <section className="screen" aria-labelledby="alias-title">
      <div className="screen-header">
        <div>
          <h1 id="alias-title">{current.label}</h1>
          <p className="alias-address alias-address-large">{current.address}</p>
        </div>
        <div className="row-actions">
          <CopyButton value={current.address} label="Copy" />
          <ShareButton value={current.address} />
        </div>
      </div>

      {!online ? <OfflineNotice /> : null}

      <div className="detail-grid">
        <div className="detail-card">
          <h2>State</h2>
          <p>
            <StateBadge state={current.state} />
          </p>
          <p>{describeState(current, now)}</p>
          <p className="muted">Expires: {formatExact(current.expiresAt)}</p>
          <p className="muted">
            Last used:{" "}
            {formatRelativeTime(current.lastUserActivityAt ?? current.lastInboundAt, now)}
          </p>
          <p className="muted">{describeRenewal(current.lease)}</p>
        </div>

        <div className="detail-card">
          <h2>Actions</h2>
          {actionStatus !== null ? (
            <StatusMessage tone={actionStatus.tone}>{actionStatus.message}</StatusMessage>
          ) : null}
          <div className="field">
            <label htmlFor="alias-duration">Lease duration</label>
            <select
              id="alias-duration"
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
            >
              {DURATION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="row-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={busy || current.state === "disabled"}
              onClick={() => void renewAndCopy()}
            >
              Renew and copy
            </button>
            <button
              type="button"
              className="button"
              disabled={busy || current.state === "disabled"}
              onClick={() =>
                void runAction("Renewed the alias.", () => client.renewAlias(id, durationBody))
              }
            >
              Renew
            </button>
            <button
              type="button"
              className="button"
              disabled={busy || current.state === "disabled" || current.expiresAt === null}
              onClick={() =>
                void runAction("Extended the alias.", () => client.extendAlias(id, durationBody))
              }
            >
              Extend
            </button>
            {current.state === "disabled" ? (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  void runAction("Enabled the alias.", () => client.enableAlias(id, {}))
                }
              >
                Enable
              </button>
            ) : (
              <button
                type="button"
                className="button button-danger"
                disabled={busy}
                onClick={() => setConfirmDisable(true)}
              >
                Disable
              </button>
            )}
          </div>
          <p className="field-hint">
            Renewing restarts the lease. Disabling stops both inbound and outbound mail.
          </p>
        </div>
      </div>

      <div className="detail-card">
        <h2>Label, purpose, and policy</h2>
        <form className="form" onSubmit={(event) => void savePolicy(event)}>
          <div className="field">
            <label htmlFor="alias-label">Label</label>
            <input
              id="alias-label"
              type="text"
              value={label}
              maxLength={200}
              required
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="alias-purpose">Purpose</label>
            <textarea
              id="alias-purpose"
              value={purpose}
              maxLength={2000}
              rows={2}
              onChange={(event) => setPurpose(event.target.value)}
            />
          </div>
          <div className="field field-checkbox">
            <input
              id="alias-renew"
              type="checkbox"
              checked={renewOnOutbound}
              onChange={(event) => setRenewOnOutbound(event.target.checked)}
            />
            <label htmlFor="alias-renew">Renew on outbound mail</label>
            <p className="field-hint">Inbound mail never renews an alias.</p>
          </div>
          {editStatus !== null ? (
            <StatusMessage tone={editStatus.tone}>{editStatus.message}</StatusMessage>
          ) : null}
          <div className="row-actions">
            <button type="submit" className="button button-primary" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>

      <div className="detail-card">
        <h2>Quarantined messages</h2>
        {quarantined.length === 0 ? (
          <p className="muted">No quarantined messages for this alias.</p>
        ) : (
          <QuarantineTable
            messages={quarantined}
            aliasAddresses={addressMap}
            now={now}
            busyId={actions.busyId}
            onRecover={(message) => void actions.recover(message)}
            onRecoverAndRenew={(message) => void actions.recoverAndRenew(message)}
            onDelete={actions.requestDelete}
            onReply={actions.requestReply}
          />
        )}
      </div>

      <div className="detail-card">
        <h2>Recent lifecycle events</h2>
        {events.loading ? (
          <LoadingState label="Loading events…" />
        ) : events.error !== null ? (
          <ErrorState error={events.error} onRetry={events.reload} />
        ) : (events.data?.events.length ?? 0) === 0 ? (
          <p className="muted">No events yet.</p>
        ) : (
          <ul className="event-list">
            {events.data!.events.map((event) => (
              <li key={event.id}>
                <span>{describeEvent(event)}</span>
                <span className="muted">{formatExact(event.occurredAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <QuarantineActionDialogs actions={actions} />

      <ConfirmDialog
        open={confirmDisable}
        title="Disable this alias?"
        destructive
        confirmLabel="Disable alias"
        busy={busy}
        description={
          <p>
            Disabled aliases reject inbound mail and cannot send. You can enable it again later.
          </p>
        }
        onConfirm={() => {
          setConfirmDisable(false);
          void runAction("Disabled the alias.", () => client.disableAlias(id));
        }}
        onCancel={() => setConfirmDisable(false)}
      />

      <div className="row-actions">
        <button type="button" className="button" onClick={() => navigate({ name: "dashboard" })}>
          Back to aliases
        </button>
      </div>
    </section>
  );
}
