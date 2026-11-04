import { useMemo, useState, type ReactNode } from "react";
import type { AliasSort, AliasState } from "wickmail-core";
import { listAllAliases, listAllQuarantine } from "../api/collections.js";
import { useApi } from "../api/context.js";
import { AliasRow } from "../components/AliasRow.js";
import { EmptyState, ErrorState, LoadingState, OfflineNotice } from "../components/ui.js";
import { useAsync } from "../hooks/useAsync.js";
import {
  DEFAULT_ALIAS_CRITERIA,
  countQuarantineByAlias,
  deriveAliasQuery,
  deriveDashboardCounts,
  sortAliases,
  type AliasCriteria,
  type ExpiryFilter,
} from "../lib/aliases.js";
import { usePreferences } from "../preferences/context.js";

/** Props for {@link DashboardScreen}. */
export interface DashboardScreenProps {
  onGenerate: () => void;
}

const EXPIRY_OPTIONS: ReadonlyArray<{ value: ExpiryFilter; label: string }> = [
  { value: "any", label: "Any expiry" },
  { value: "24h", label: "Expiring within 24 hours" },
  { value: "7d", label: "Expiring within 7 days" },
  { value: "custom", label: "Custom range" },
  { value: "none", label: "No expiry" },
];

const SORT_OPTIONS: ReadonlyArray<{ value: AliasSort; label: string }> = [
  { value: "expires", label: "Expiry" },
  { value: "lastUsed", label: "Recently used" },
  { value: "created", label: "Recently created" },
];

/** The dashboard: counts, search, filters, sorting, and the alias list. */
export function DashboardScreen({ onGenerate }: DashboardScreenProps): ReactNode {
  const { client, online } = useApi();
  const { preferences } = usePreferences();
  const [criteria, setCriteria] = useState<AliasCriteria>(DEFAULT_ALIAS_CRITERIA);
  const [sort, setSort] = useState<AliasSort>("expires");

  const all = useAsync(() => listAllAliases(client), [client]);
  const quarantine = useAsync(() => listAllQuarantine(client), [client]);
  const visible = useAsync(
    () => client.listAliases(deriveAliasQuery(criteria, sort, Date.now())),
    [
      client,
      sort,
      criteria.search,
      criteria.state,
      criteria.expiry,
      criteria.customAfter,
      criteria.customBefore,
    ],
  );

  const now = Date.now();
  const quarantineCounts = useMemo(
    () => countQuarantineByAlias(quarantine.data ?? []),
    [quarantine.data],
  );
  const counts = useMemo(
    () => deriveDashboardCounts(all.data ?? [], quarantineCounts, now, preferences.expiringSoonMs),
    [all.data, quarantineCounts, now, preferences.expiringSoonMs],
  );
  const rows = useMemo(() => sortAliases(visible.data?.aliases ?? [], sort), [visible.data, sort]);

  function patch(next: Partial<AliasCriteria>): void {
    setCriteria((current) => ({ ...current, ...next }));
  }

  return (
    <section className="screen" aria-labelledby="dashboard-title">
      <div className="screen-header">
        <h1 id="dashboard-title">Aliases</h1>
        <button type="button" className="button button-primary" onClick={onGenerate}>
          Generate alias
        </button>
      </div>

      {!online ? <OfflineNotice /> : null}

      <ul className="counts" aria-label="Alias counts">
        <li className="count count-active" data-testid="count-active">
          <span className="count-value">{counts.active}</span>
          <span className="count-label">Active</span>
        </li>
        <li className="count count-soon" data-testid="count-expiring">
          <span className="count-value">{counts.expiringSoon}</span>
          <span className="count-label">Expiring soon</span>
        </li>
        <li className="count count-expired" data-testid="count-expired">
          <span className="count-value">{counts.expired}</span>
          <span className="count-label">Expired</span>
        </li>
        <li className="count count-quarantined" data-testid="count-quarantined">
          <span className="count-value">{counts.quarantined}</span>
          <span className="count-label">Quarantined</span>
        </li>
      </ul>

      <form className="filters" role="search" onSubmit={(event) => event.preventDefault()}>
        <div className="field">
          <label htmlFor="alias-search">Search</label>
          <input
            id="alias-search"
            type="search"
            value={criteria.search}
            placeholder="Label, purpose, or address"
            onChange={(event) => patch({ search: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="alias-state">State</label>
          <select
            id="alias-state"
            value={criteria.state}
            onChange={(event) => patch({ state: event.target.value as AliasState | "all" })}
          >
            <option value="all">Any state</option>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="alias-expiry">Expiry</label>
          <select
            id="alias-expiry"
            value={criteria.expiry}
            onChange={(event) => patch({ expiry: event.target.value as ExpiryFilter })}
          >
            {EXPIRY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {criteria.expiry === "custom" ? (
          <>
            <div className="field">
              <label htmlFor="alias-expiry-after">Expires after</label>
              <input
                id="alias-expiry-after"
                type="date"
                value={criteria.customAfter}
                onChange={(event) => patch({ customAfter: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="alias-expiry-before">Expires before</label>
              <input
                id="alias-expiry-before"
                type="date"
                value={criteria.customBefore}
                onChange={(event) => patch({ customBefore: event.target.value })}
              />
            </div>
          </>
        ) : null}
        <div className="field">
          <label htmlFor="alias-sort">Sort by</label>
          <select
            id="alias-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as AliasSort)}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </form>

      {visible.loading ? (
        <LoadingState label="Loading aliases…" />
      ) : visible.error !== null ? (
        <ErrorState error={visible.error} onRetry={visible.reload} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No aliases match"
          action={
            <button type="button" className="button button-primary" onClick={onGenerate}>
              Generate alias
            </button>
          }
        >
          Adjust the filters, or generate a new alias.
        </EmptyState>
      ) : (
        <ul className="alias-list">
          {rows.map((alias) => (
            <AliasRow
              key={alias.id}
              alias={alias}
              now={now}
              quarantinedCount={quarantineCounts[alias.id] ?? 0}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
