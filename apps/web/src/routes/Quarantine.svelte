<script lang="ts">
  import type { Alias, QuarantineResponse, QuarantineStatus } from "@wickmail/core";
  import { session } from "../lib/session.svelte";
  import { filterQuarantine, isHeld, type QuarantineFilters } from "../lib/quarantine";
  import { formatAbsolute, formatRelative } from "../lib/format";
  import { confirm } from "../lib/confirm.svelte";
  import { toasts } from "../lib/toasts.svelte";
  import Spinner from "../components/Spinner.svelte";
  import ErrorBanner from "../components/ErrorBanner.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import ReplyComposerDialog from "../components/ReplyComposerDialog.svelte";

  let items = $state<QuarantineResponse[]>([]);
  let aliases = $state<Alias[]>([]);
  let loading = $state(true);
  let error = $state<unknown>(null);
  let busy = $state(false);
  let actionError = $state<unknown>(null);
  let now = $state(Date.now());
  let filters = $state<QuarantineFilters>({ aliasId: "", search: "", from: "", to: "" });
  let replyTarget = $state<string | null>(null);

  const statusLabels: Record<QuarantineStatus, string> = {
    quarantined: "Quarantined",
    recovering: "Recovering",
    recovered: "Recovered",
    deleting: "Deleting",
    deleted: "Deleted",
  };

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const [page, aliasPage] = await Promise.all([
        session.client.listQuarantine({ limit: 200 }),
        session.client.listAliases({ limit: 200 }),
      ]);
      items = page.items;
      aliases = aliasPage.items;
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

  const visible = $derived(filterQuarantine(items, filters));
  const addressById = $derived(new Map(aliases.map((alias) => [alias.id, alias.address])));

  function addressFor(aliasIds: string[]): string {
    if (aliasIds.length === 0) return "Primary address";
    return aliasIds.map((id) => addressById.get(id) ?? id).join(", ");
  }

  async function recover(item: QuarantineResponse, renew: boolean): Promise<void> {
    busy = true;
    actionError = null;
    try {
      await session.client.recoverQuarantine(item.messageId, { renew, enable: renew });
      toasts.success(renew ? "Message recovered and alias renewed" : "Message recovered");
      await load();
    } catch (caught) {
      actionError = caught;
    } finally {
      busy = false;
    }
  }

  async function remove(item: QuarantineResponse): Promise<void> {
    const confirmed = await confirm.ask({
      title: "Delete quarantined message?",
      message: "This permanently deletes the quarantined message. It cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    busy = true;
    actionError = null;
    try {
      await session.client.deleteQuarantine(item.messageId);
      toasts.success("Message deleted");
      await load();
    } catch (caught) {
      actionError = caught;
    } finally {
      busy = false;
    }
  }

  async function reply(item: QuarantineResponse): Promise<void> {
    if (isHeld(item)) {
      const confirmed = await confirm.ask({
        title: "Recover before replying?",
        message: "Replying requires recovering the message and renewing the alias first.",
        confirmLabel: "Recover and renew",
      });
      if (!confirmed) return;
      busy = true;
      actionError = null;
      try {
        await session.client.recoverQuarantine(item.messageId, { renew: true, enable: true });
        toasts.success("Message recovered and alias renewed");
        await load();
      } catch (caught) {
        actionError = caught;
        return;
      } finally {
        busy = false;
      }
    }
    replyTarget = item.messageId;
  }
</script>

<svelte:head><title>Quarantine · Wickmail</title></svelte:head>

<section class="page">
  <header class="page-header">
    <div>
      <h1>Quarantine</h1>
      <p class="muted">
        Mail held for expired or disabled aliases, recoverable without an IMAP client.
      </p>
    </div>
  </header>

  {#if loading}
    <Spinner label="Loading quarantine" />
  {:else if error}
    <ErrorBanner {error} onRetry={load} />
  {:else}
    {#if actionError}
      <ErrorBanner error={actionError} />
    {/if}

    <div class="filters">
      <label class="field">
        <span>Alias</span>
        <select bind:value={filters.aliasId}>
          <option value="">All aliases</option>
          {#each aliases as alias (alias.id)}
            <option value={alias.id}
              >{alias.label ? `${alias.label} (${alias.address})` : alias.address}</option
            >
          {/each}
        </select>
      </label>
      <label class="field">
        <span>Search</span>
        <input type="search" placeholder="Sender or subject" bind:value={filters.search} />
      </label>
      <label class="field">
        <span>Received after</span>
        <input type="date" bind:value={filters.from} />
      </label>
      <label class="field">
        <span>Received before</span>
        <input type="date" bind:value={filters.to} />
      </label>
    </div>

    {#if items.length === 0}
      <EmptyState
        title="Nothing in quarantine"
        description="Mail held for expired aliases appears here."
      />
    {:else if visible.length === 0}
      <EmptyState title="No matching messages" description="Adjust the filters." />
    {:else}
      <ul class="record-list">
        {#each visible as item (item.messageId)}
          <li class="record">
            <div class="record-body">
              <p class="record-title">{item.subject || "(no subject)"}</p>
              <p class="muted">
                From {item.sender} · received {formatRelative(item.receivedAt, now)}
                <span class="muted">({formatAbsolute(item.receivedAt)})</span>
              </p>
              <p class="muted">
                To {addressFor(item.aliasIds)} · retained until
                {formatAbsolute(item.quarantineExpiresAt)} ({formatRelative(
                  item.quarantineExpiresAt,
                  now,
                )})
              </p>
              <p class="muted">
                {item.kind === "spam" ? "Spam" : "Lease quarantine"} · {statusLabels[item.status]}
              </p>
            </div>
            <div class="actions">
              {#if isHeld(item)}
                <button
                  type="button"
                  class="button button-small"
                  onclick={() => recover(item, false)}
                  disabled={busy}>Recover</button
                >
                <button
                  type="button"
                  class="button button-small"
                  onclick={() => recover(item, true)}
                  disabled={busy}>Recover &amp; renew</button
                >
              {/if}
              <button
                type="button"
                class="button button-small"
                onclick={() => reply(item)}
                disabled={busy}>Reply</button
              >
              {#if isHeld(item)}
                <button
                  type="button"
                  class="button button-small button-danger"
                  onclick={() => remove(item)}
                  disabled={busy}>Delete</button
                >
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

{#if replyTarget}
  <ReplyComposerDialog messageId={replyTarget} onClose={() => (replyTarget = null)} onSent={load} />
{/if}
