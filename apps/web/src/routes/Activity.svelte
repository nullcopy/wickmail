<script lang="ts">
  import type { Alias, AliasEvent } from "@wickmail/core";
  import { session } from "../lib/session.svelte";
  import { aliasPath, router } from "../lib/router.svelte";
  import { EVENT_LABELS } from "../lib/events";
  import { formatAbsolute, formatRelative } from "../lib/format";
  import Spinner from "../components/Spinner.svelte";
  import ErrorBanner from "../components/ErrorBanner.svelte";
  import EmptyState from "../components/EmptyState.svelte";

  interface Entry {
    alias: Alias;
    event: AliasEvent;
  }

  let entries = $state<Entry[]>([]);
  let loading = $state(true);
  let error = $state<unknown>(null);
  let now = $state(Date.now());

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const page = await session.client.listAliases({ limit: 200 });
      const lists = await Promise.all(
        page.items.map(async (alias) => {
          try {
            const events = await session.client.listAliasEvents(alias.id);
            return events.map((event) => ({ alias, event }));
          } catch {
            return [];
          }
        }),
      );
      const merged = lists.flat();
      merged.sort((left, right) => {
        const diff = Date.parse(right.event.createdAt) - Date.parse(left.event.createdAt);
        return diff || right.event.id.localeCompare(left.event.id);
      });
      entries = merged.slice(0, 200);
      now = Date.now();
    } catch (caught) {
      error = caught;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  function go(event: MouseEvent, to: string): void {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    router.navigate(to);
  }
</script>

<svelte:head><title>Activity · Wickmail</title></svelte:head>

<section class="page">
  <header class="page-header">
    <div>
      <h1>Activity</h1>
      <p class="muted">Lifecycle events across every alias, newest first.</p>
    </div>
  </header>

  {#if loading}
    <Spinner label="Loading activity" />
  {:else if error}
    <ErrorBanner {error} onRetry={load} />
  {:else if entries.length === 0}
    <EmptyState title="No activity yet" description="Lifecycle events appear as aliases change." />
  {:else}
    <ol class="timeline">
      {#each entries as entry (entry.event.id)}
        <li class="timeline-item">
          <span class="timeline-kind">{EVENT_LABELS[entry.event.kind]}</span>
          <a
            href={aliasPath(entry.alias.id)}
            onclick={(event) => go(event, aliasPath(entry.alias.id))}
          >
            {entry.alias.label ?? entry.alias.address}
          </a>
          <span class="muted"
            >{formatAbsolute(entry.event.createdAt)} · {formatRelative(
              entry.event.createdAt,
              now,
            )}</span
          >
        </li>
      {/each}
    </ol>
  {/if}
</section>
