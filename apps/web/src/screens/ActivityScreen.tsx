import { useMemo, type ReactNode } from "react";
import type { Alias, AliasEvent } from "wickmail-core";
import { listAllAliases } from "../api/collections.js";
import { useApi } from "../api/context.js";
import { EmptyState, ErrorState, LoadingState, OfflineNotice } from "../components/ui.js";
import { useAsync } from "../hooks/useAsync.js";
import { describeEvent } from "../lib/generate.js";
import { formatExact, formatRelativeTime } from "../lib/format.js";
import { routeToHash } from "../lib/router.js";

interface FeedEntry {
  event: AliasEvent;
  alias: Alias;
}

/** The activity screen: lifecycle events across every alias, newest first. */
export function ActivityScreen(): ReactNode {
  const { client, online } = useApi();
  const aliases = useAsync(() => listAllAliases(client), [client]);

  const feed = useAsync<FeedEntry[]>(async () => {
    const list = aliases.data ?? [];
    const pages = await Promise.all(
      list.map((alias) =>
        client
          .listAliasEvents(alias.id)
          .then((response) => response.events.map((event) => ({ event, alias }))),
      ),
    );
    return pages
      .flat()
      .sort(
        (left, right) =>
          Date.parse(right.event.occurredAt) - Date.parse(left.event.occurredAt) ||
          right.event.id.localeCompare(left.event.id),
      );
  }, [client, aliases.data]);

  const now = Date.now();
  const entries = useMemo(() => feed.data ?? [], [feed.data]);

  return (
    <section className="screen" aria-labelledby="activity-title">
      <div className="screen-header">
        <h1 id="activity-title">Activity</h1>
      </div>
      <p className="screen-intro">
        Lifecycle events across your aliases. Expired is a presentation state derived from the
        stored expiry, not a stored event.
      </p>

      {!online ? <OfflineNotice /> : null}

      {aliases.loading || feed.loading ? (
        <LoadingState label="Loading activity…" />
      ) : aliases.error !== null ? (
        <ErrorState error={aliases.error} onRetry={aliases.reload} />
      ) : feed.error !== null ? (
        <ErrorState error={feed.error} onRetry={feed.reload} />
      ) : entries.length === 0 ? (
        <EmptyState title="No activity yet">
          Generating an alias, renewing it, or replying as it records an event here.
        </EmptyState>
      ) : (
        <ul className="event-list event-list-wide">
          {entries.map(({ event, alias }) => (
            <li key={event.id}>
              <span className="event-alias">
                <a href={routeToHash({ name: "alias", id: alias.id })}>{alias.label}</a>
              </span>
              <span>{describeEvent(event)}</span>
              <span className="muted">
                {formatRelativeTime(event.occurredAt, now)} · {formatExact(event.occurredAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
