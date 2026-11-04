<script lang="ts">
  import type { Alias, Message, MessageRoute } from "@wickmail/core";
  import { session } from "../lib/session.svelte";
  import { defaultMessageFilters, filterMessages, type MessageFilters } from "../lib/messages";
  import { formatAbsolute, formatRelative } from "../lib/format";
  import { confirm } from "../lib/confirm.svelte";
  import { toasts } from "../lib/toasts.svelte";
  import Spinner from "../components/Spinner.svelte";
  import ErrorBanner from "../components/ErrorBanner.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import ReplyComposerDialog from "../components/ReplyComposerDialog.svelte";

  let messages = $state<Message[]>([]);
  let aliases = $state<Alias[]>([]);
  let loading = $state(true);
  let error = $state<unknown>(null);
  let busy = $state(false);
  let actionError = $state<unknown>(null);
  let now = $state(Date.now());
  let filters = $state<MessageFilters>(defaultMessageFilters());
  let replyTarget = $state<string | null>(null);

  const routeLabels: Record<MessageRoute, string> = {
    inbox: "Inbox",
    spam: "Spam",
    quarantine: "Quarantine",
  };

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const [page, aliasPage] = await Promise.all([
        session.client.listMessages({ limit: 200 }),
        session.client.listAliases({ limit: 200 }),
      ]);
      messages = page.items;
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

  const visible = $derived(filterMessages(messages, filters));
  const addressById = $derived(new Map(aliases.map((alias) => [alias.id, alias.address])));

  function addressFor(aliasIds: string[], primaryReceived: boolean): string {
    const names = aliasIds.map((id) => addressById.get(id) ?? id);
    if (primaryReceived) names.push("primary address");
    return names.length > 0 ? names.join(", ") : "unknown";
  }

  async function reply(message: Message): Promise<void> {
    if (message.route === "quarantine") {
      const confirmed = await confirm.ask({
        title: "Recover before replying?",
        message: "Replying requires recovering the message and renewing the alias first.",
        confirmLabel: "Recover and renew",
      });
      if (!confirmed) return;
      busy = true;
      actionError = null;
      try {
        await session.client.recoverQuarantine(message.messageId, { renew: true, enable: true });
        toasts.success("Message recovered and alias renewed");
        await load();
      } catch (caught) {
        actionError = caught;
        return;
      } finally {
        busy = false;
      }
    }
    replyTarget = message.messageId;
  }
</script>

<svelte:head><title>Messages · Wickmail</title></svelte:head>

<section class="page">
  <header class="page-header">
    <div>
      <h1>Messages</h1>
      <p class="muted">A limited recent-message list tied to aliases and quarantine.</p>
    </div>
  </header>

  {#if loading}
    <Spinner label="Loading messages" />
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

    {#if messages.length === 0}
      <EmptyState title="No recent messages" description="Accepted mail appears here." />
    {:else if visible.length === 0}
      <EmptyState title="No matching messages" description="Adjust the filters." />
    {:else}
      <ul class="record-list">
        {#each visible as message (message.messageId)}
          <li class="record">
            <div class="record-body">
              <p class="record-title">{message.subject || "(no subject)"}</p>
              <p class="muted">
                From {message.sender} · received {formatRelative(message.receivedAt, now)}
                <span class="muted">({formatAbsolute(message.receivedAt)})</span>
              </p>
              <p class="muted">
                To {addressFor(message.aliasIds, message.primaryReceived)} · {routeLabels[
                  message.route
                ]}
              </p>
            </div>
            <div class="actions">
              <button
                type="button"
                class="button button-small"
                onclick={() => reply(message)}
                disabled={busy}>Reply</button
              >
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
