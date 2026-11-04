import { useMemo, useState, type ReactNode } from "react";
import type { QuarantineStatus } from "wickmail-core";
import { listAllAliases, listAllQuarantine } from "../api/collections.js";
import { useApi } from "../api/context.js";
import { QuarantineActionDialogs } from "../components/QuarantineDialogs.js";
import { QuarantineTable } from "../components/QuarantineTable.js";
import { EmptyState, ErrorState, LoadingState, OfflineNotice } from "../components/ui.js";
import { useAsync } from "../hooks/useAsync.js";
import { useQuarantineActions } from "../hooks/useQuarantineActions.js";
import { aliasAddressMap, sortAliases } from "../lib/aliases.js";
import {
  DEFAULT_QUARANTINE_CRITERIA,
  filterQuarantine,
  sortQuarantineByReceived,
  type QuarantineCriteria,
} from "../lib/quarantine.js";

const STATUS_OPTIONS: ReadonlyArray<{ value: QuarantineStatus | "all"; label: string }> = [
  { value: "all", label: "All recent messages" },
  { value: "quarantined", label: "Quarantined" },
  { value: "recovered", label: "Recovered" },
  { value: "deleted", label: "Deleted" },
];

/**
 * The messages screen: a limited recent-message list tied to aliases and
 * quarantine, with the reply action and its provenance. It is not a general
 * mail browser.
 */
export function MessagesScreen(): ReactNode {
  const { client, online } = useApi();
  const [criteria, setCriteria] = useState<QuarantineCriteria>(DEFAULT_QUARANTINE_CRITERIA);
  const [status, setStatus] = useState<QuarantineStatus | "all">("all");

  const quarantine = useAsync(() => listAllQuarantine(client), [client]);
  const aliases = useAsync(() => listAllAliases(client), [client]);
  const actions = useQuarantineActions(quarantine.reload);

  const now = Date.now();
  const addresses = useMemo(() => aliasAddressMap(aliases.data ?? []), [aliases.data]);
  const aliasOptions = useMemo(() => sortAliases(aliases.data ?? [], "created"), [aliases.data]);
  const rows = useMemo(() => {
    const filtered = filterQuarantine(quarantine.data ?? [], criteria);
    return sortQuarantineByReceived(
      status === "all" ? filtered : filtered.filter((message) => message.status === status),
    );
  }, [quarantine.data, criteria, status]);

  function patch(next: Partial<QuarantineCriteria>): void {
    setCriteria((current) => ({ ...current, ...next }));
  }

  return (
    <section className="screen" aria-labelledby="messages-title">
      <div className="screen-header">
        <h1 id="messages-title">Messages</h1>
      </div>
      <p className="screen-intro">
        Recent messages tied to your aliases and quarantine. Open a message to reply as the alias
        that received it. Folder browsing and general search are out of scope.
      </p>

      {!online ? <OfflineNotice /> : null}
      <QuarantineActionDialogs actions={actions} />

      <form className="filters" onSubmit={(event) => event.preventDefault()}>
        <div className="field">
          <label htmlFor="messages-alias">Alias</label>
          <select
            id="messages-alias"
            value={criteria.aliasId}
            onChange={(event) => patch({ aliasId: event.target.value })}
          >
            <option value="all">All aliases</option>
            {aliasOptions.map((alias) => (
              <option key={alias.id} value={alias.id}>
                {alias.label} — {alias.address}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="messages-status">Status</label>
          <select
            id="messages-status"
            value={status}
            onChange={(event) => setStatus(event.target.value as QuarantineStatus | "all")}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="messages-search">Search</label>
          <input
            id="messages-search"
            type="search"
            value={criteria.search}
            placeholder="Sender or subject"
            onChange={(event) => patch({ search: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="messages-from">Received after</label>
          <input
            id="messages-from"
            type="date"
            value={criteria.from}
            onChange={(event) => patch({ from: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="messages-to">Received before</label>
          <input
            id="messages-to"
            type="date"
            value={criteria.to}
            onChange={(event) => patch({ to: event.target.value })}
          />
        </div>
      </form>

      {quarantine.loading ? (
        <LoadingState label="Loading messages…" />
      ) : quarantine.error !== null ? (
        <ErrorState error={quarantine.error} onRetry={quarantine.reload} />
      ) : rows.length === 0 ? (
        <EmptyState title="No recent messages">
          Messages from your aliases and quarantine appear here.
        </EmptyState>
      ) : (
        <QuarantineTable
          messages={rows}
          aliasAddresses={addresses}
          now={now}
          busyId={actions.busyId}
          onRecover={(message) => void actions.recover(message)}
          onRecoverAndRenew={(message) => void actions.recoverAndRenew(message)}
          onDelete={actions.requestDelete}
          onReply={actions.requestReply}
        />
      )}
    </section>
  );
}
