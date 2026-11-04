import { useMemo, useState, type ReactNode } from "react";
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

/** The quarantine screen: review and recover or delete quarantined mail. */
export function QuarantineScreen(): ReactNode {
  const { client, online } = useApi();
  const [criteria, setCriteria] = useState<QuarantineCriteria>(DEFAULT_QUARANTINE_CRITERIA);

  const quarantine = useAsync(() => listAllQuarantine(client), [client]);
  const aliases = useAsync(() => listAllAliases(client), [client]);
  const actions = useQuarantineActions(quarantine.reload);

  const now = Date.now();
  const addresses = useMemo(() => aliasAddressMap(aliases.data ?? []), [aliases.data]);
  const aliasOptions = useMemo(() => sortAliases(aliases.data ?? [], "created"), [aliases.data]);
  const rows = useMemo(
    () =>
      sortQuarantineByReceived(
        filterQuarantine(
          (quarantine.data ?? []).filter((message) => message.status === "quarantined"),
          criteria,
        ),
      ),
    [quarantine.data, criteria],
  );

  function patch(next: Partial<QuarantineCriteria>): void {
    setCriteria((current) => ({ ...current, ...next }));
  }

  return (
    <section className="screen" aria-labelledby="quarantine-title">
      <div className="screen-header">
        <h1 id="quarantine-title">Quarantine</h1>
      </div>
      <p className="screen-intro">
        Mail sent to an expired alias is held here until it is recovered or removed. Recovering a
        message does not renew its alias unless you choose to renew.
      </p>

      {!online ? <OfflineNotice /> : null}
      <QuarantineActionDialogs actions={actions} />

      <form className="filters" onSubmit={(event) => event.preventDefault()}>
        <div className="field">
          <label htmlFor="quarantine-alias">Alias</label>
          <select
            id="quarantine-alias"
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
          <label htmlFor="quarantine-search">Search</label>
          <input
            id="quarantine-search"
            type="search"
            value={criteria.search}
            placeholder="Sender or subject"
            onChange={(event) => patch({ search: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="quarantine-from">Received after</label>
          <input
            id="quarantine-from"
            type="date"
            value={criteria.from}
            onChange={(event) => patch({ from: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="quarantine-to">Received before</label>
          <input
            id="quarantine-to"
            type="date"
            value={criteria.to}
            onChange={(event) => patch({ to: event.target.value })}
          />
        </div>
      </form>

      {quarantine.loading ? (
        <LoadingState label="Loading quarantined mail…" />
      ) : quarantine.error !== null ? (
        <ErrorState error={quarantine.error} onRetry={quarantine.reload} />
      ) : rows.length === 0 ? (
        <EmptyState title="No quarantined mail">
          Messages sent to an expired alias appear here.
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
