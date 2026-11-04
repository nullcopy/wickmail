import type { ReactNode } from "react";
import type { Alias } from "wickmail-core";
import { StateBadge } from "./ui.js";
import { describeRenewal, formatExact, formatRelativeTime, lastUsedAt } from "../lib/format.js";
import { routeToHash } from "../lib/router.js";

/** Props for {@link AliasRow}. */
export interface AliasRowProps {
  alias: Alias;
  quarantinedCount: number;
  now: number;
}

/** One alias row on the dashboard. */
export function AliasRow({ alias, quarantinedCount, now }: AliasRowProps): ReactNode {
  return (
    <li className="alias-row">
      <div className="alias-identity">
        <a className="alias-label" href={routeToHash({ name: "alias", id: alias.id })}>
          {alias.label}
        </a>
        <span className="alias-address">{alias.address}</span>
      </div>
      <div className="alias-cell">
        <StateBadge state={alias.state} />
      </div>
      <div className="alias-cell">
        <span className="alias-value">
          {alias.expiresAt === null ? "No expiry" : formatRelativeTime(alias.expiresAt, now)}
        </span>
        <span className="muted">{formatExact(alias.expiresAt)}</span>
      </div>
      <div className="alias-cell">
        <span className="alias-value">Last used {formatRelativeTime(lastUsedAt(alias), now)}</span>
        <span className="muted">{formatExact(lastUsedAt(alias))}</span>
      </div>
      <div className="alias-cell">
        <span className="alias-value">{describeRenewal(alias.lease)}</span>
      </div>
      <div className="alias-cell">
        {quarantinedCount > 0 ? (
          <span className="alias-quarantine-count">{quarantinedCount} quarantined</span>
        ) : (
          <span className="muted">None</span>
        )}
      </div>
    </li>
  );
}
