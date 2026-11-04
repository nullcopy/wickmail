<script lang="ts">
  import type { Alias, AliasState, QuarantineResponse } from "@wickmail/core";
  import { session } from "../lib/session.svelte";
  import { aliasPath, router } from "../lib/router.svelte";
  import {
    aliasCounts,
    filterAliases,
    quarantineCounts,
    sortAliases,
    type AliasFilters,
    type AliasSortKey,
    type ExpiryFilter,
  } from "../lib/aliases";
  import { describeAlias, formatAbsolute, formatRelative, plural } from "../lib/format";
  import Spinner from "../components/Spinner.svelte";
  import ErrorBanner from "../components/ErrorBanner.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import StatusBadge from "../components/StatusBadge.svelte";
  import NewAliasDialog from "../components/NewAliasDialog.svelte";

  type ExpiryChoice = "any" | "none" | "24h" | "7d" | "range";

  let aliases = $state<Alias[]>([]);
  let quarantine = $state<QuarantineResponse[]>([]);
  let loading = $state(true);
  let error = $state<unknown>(null);
  let truncated = $state(false);
  let showGenerate = $state(false);
  let now = $state(Date.now());

  let search = $state("");
  let states = $state<AliasState[]>([]);
  let expiryChoice = $state<ExpiryChoice>("any");
  let rangeFrom = $state("");
  let rangeTo = $state("");
  let sort = $state<AliasSortKey>("expires");

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const [aliasPage, quarantinePage] = await Promise.all([
        session.client.listAliases({ limit: 200, sort: "expires", order: "asc" }),
        session.client.listQuarantine({ status: "quarantined", limit: 200 }),
      ]);
      aliases = aliasPage.items;
      truncated = aliasPage.nextCursor !== null;
      quarantine = quarantinePage.items;
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

  const expiryFilter = $derived<ExpiryFilter>(
    expiryChoice === "none"
      ? { kind: "none" }
      : expiryChoice === "24h"
        ? { kind: "within", seconds: 24 * 60 * 60 }
        : expiryChoice === "7d"
          ? { kind: "within", seconds: 7 * 24 * 60 * 60 }
          : expiryChoice === "range"
            ? { kind: "range", from: rangeFrom, to: rangeTo }
            : { kind: "any" },
  );

  const filters = $derived<AliasFilters>({ search, states, expiry: expiryFilter });
  const counts = $derived(aliasCounts(aliases, session.preferences.expiringSoonSeconds, now));
  const quarantinedByAlias = $derived(quarantineCounts(quarantine));
  const visible = $derived(sortAliases(filterAliases(aliases, filters, now), sort));

  const stateOptions: { value: AliasState; label: string }[] = [
    { value: "active", label: "Active" },
    { value: "expired", label: "Expired" },
    { value: "disabled", label: "Disabled" },
  ];

  function toggleState(state: AliasState): void {
    states = states.includes(state)
      ? states.filter((value) => value !== state)
      : [...states, state];
  }

  function go(event: MouseEvent, to: string): void {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    router.navigate(to);
  }
</script>

<svelte:head><title>Dashboard · Wickmail</title></svelte:head>

<section class="page">
  <header class="page-header">
    <div>
      <h1>Aliases</h1>
      <p class="muted">Server-computed state, expiry, and recent activity.</p>
    </div>
    <button type="button" class="button button-primary" onclick={() => (showGenerate = true)}>
      Generate alias
    </button>
  </header>

  {#if loading}
    <Spinner label="Loading aliases" />
  {:else if error}
    <ErrorBanner {error} onRetry={load} />
  {:else}
    <ul class="counts">
      <li class="count">
        <span class="count-value">{counts.active}</span>
        <span class="count-label">Active</span>
      </li>
      <li class="count">
        <span class="count-value">{counts.expiringSoon}</span>
        <span class="count-label">Expiring soon</span>
      </li>
      <li class="count">
        <span class="count-value">{counts.expired}</span>
        <span class="count-label">Expired</span>
      </li>
      <li class="count">
        <span class="count-value">{quarantine.length}</span>
        <span class="count-label">Quarantined</span>
      </li>
    </ul>

    <div class="filters">
      <label class="field">
        <span>Search</span>
        <input type="search" placeholder="Label, purpose, or address" bind:value={search} />
      </label>

      <fieldset class="field">
        <legend>State</legend>
        {#each stateOptions as option (option.value)}
          <label class="choice">
            <input
              type="checkbox"
              checked={states.includes(option.value)}
              onchange={() => toggleState(option.value)}
            />
            {option.label}
          </label>
        {/each}
      </fieldset>

      <label class="field">
        <span>Expiry</span>
        <select bind:value={expiryChoice}>
          <option value="any">Any expiry</option>
          <option value="24h">Expiring within 24 hours</option>
          <option value="7d">Expiring within 7 days</option>
          <option value="range">Custom range</option>
          <option value="none">No expiry</option>
        </select>
      </label>

      {#if expiryChoice === "range"}
        <label class="field">
          <span>From</span>
          <input type="date" bind:value={rangeFrom} />
        </label>
        <label class="field">
          <span>To</span>
          <input type="date" bind:value={rangeTo} />
        </label>
      {/if}

      <label class="field">
        <span>Sort</span>
        <select bind:value={sort}>
          <option value="expires">Expiry (soonest first)</option>
          <option value="lastUsed">Recently used</option>
          <option value="created">Recently created</option>
        </select>
      </label>
    </div>

    {#if truncated}
      <p class="muted">Showing the first 200 aliases.</p>
    {/if}

    {#if aliases.length === 0}
      <EmptyState
        title="No aliases yet"
        description="Generate a readable address for a merchant, order, or purpose."
      >
        <button type="button" class="button button-primary" onclick={() => (showGenerate = true)}>
          Generate alias
        </button>
      </EmptyState>
    {:else if visible.length === 0}
      <EmptyState
        title="No matching aliases"
        description="Adjust the search, state, or expiry filters."
      />
    {:else}
      <ul class="alias-list" aria-label="Aliases">
        {#each visible as alias (alias.id)}
          {@const quarantined = quarantinedByAlias.get(alias.id) ?? 0}
          <li class="alias-row">
            <a
              class="alias-link"
              href={aliasPath(alias.id)}
              onclick={(event) => go(event, aliasPath(alias.id))}
            >
              <span class="alias-head">
                <span class="alias-label">{alias.label ?? "Untitled alias"}</span>
                <span class="alias-address">{alias.address}</span>
              </span>
              <span class="alias-field">
                <span class="field-label">State</span>
                <StatusBadge state={alias.state} />
              </span>
              <span class="alias-field">
                <span class="field-label">Expiry</span>
                <span title={alias.expiresAt ? formatAbsolute(alias.expiresAt) : "No expiry"}>
                  {describeAlias(alias, now)}
                </span>
              </span>
              <span class="alias-field">
                <span class="field-label">Last used</span>
                <span title={formatAbsolute(alias.lastUsedAt)}>
                  {formatRelative(alias.lastUsedAt, now)}
                </span>
              </span>
              <span class="alias-field">
                <span class="field-label">Renewal</span>
                {alias.renewOnOutbound ? "Renews on reply" : "Does not renew"}
              </span>
              <span class="alias-field">
                <span class="field-label">Quarantined</span>
                {quarantined}
                {plural(quarantined, "message")}
              </span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

{#if showGenerate}
  <NewAliasDialog onClose={() => (showGenerate = false)} onCreated={load} />
{/if}
