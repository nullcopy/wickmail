<script lang="ts">
  import type { Alias, AliasEvent, Message, QuarantineResponse } from "@wickmail/core";
  import { session } from "../lib/session.svelte";
  import { router } from "../lib/router.svelte";
  import { copyText } from "../lib/clipboard";
  import { EVENT_LABELS } from "../lib/events";
  import { describeAlias, formatAbsolute, formatDuration, formatRelative } from "../lib/format";
  import { confirm } from "../lib/confirm.svelte";
  import { toasts } from "../lib/toasts.svelte";
  import Spinner from "../components/Spinner.svelte";
  import ErrorBanner from "../components/ErrorBanner.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import StatusBadge from "../components/StatusBadge.svelte";
  import CopyButton from "../components/CopyButton.svelte";
  import ShareButton from "../components/ShareButton.svelte";
  import ReplyComposerDialog from "../components/ReplyComposerDialog.svelte";

  interface Props {
    id: string;
  }

  let { id }: Props = $props();

  let alias = $state<Alias | null>(null);
  let events = $state<AliasEvent[]>([]);
  let messages = $state<Message[]>([]);
  let quarantine = $state<QuarantineResponse[]>([]);
  let loading = $state(true);
  let error = $state<unknown>(null);
  let busy = $state(false);
  let actionError = $state<unknown>(null);
  let now = $state(Date.now());

  let editLabel = $state("");
  let editPurpose = $state("");
  let editRenew = $state(true);
  let expiryInput = $state("");
  let replyTarget = $state<{ id: string; quarantined: boolean } | null>(null);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const [loaded, loadedEvents, loadedMessages, loadedQuarantine] = await Promise.all([
        session.client.getAlias(id),
        session.client.listAliasEvents(id),
        session.client.listMessages({ aliasId: id, limit: 10 }),
        session.client.listQuarantine({ aliasId: id, limit: 10 }),
      ]);
      apply(loaded);
      events = loadedEvents;
      messages = loadedMessages.items;
      quarantine = loadedQuarantine.items;
      now = Date.now();
    } catch (caught) {
      error = caught;
    } finally {
      loading = false;
    }
  }

  function apply(loaded: Alias): void {
    alias = loaded;
    editLabel = loaded.label ?? "";
    editPurpose = loaded.purpose ?? "";
    editRenew = loaded.renewOnOutbound;
  }

  async function refresh(): Promise<void> {
    if (!alias) return;
    try {
      const [loadedEvents, loadedMessages, loadedQuarantine] = await Promise.all([
        session.client.listAliasEvents(id),
        session.client.listMessages({ aliasId: id, limit: 10 }),
        session.client.listQuarantine({ aliasId: id, limit: 10 }),
      ]);
      events = loadedEvents;
      messages = loadedMessages.items;
      quarantine = loadedQuarantine.items;
    } catch {
      // Keep the current lists if a refresh fails.
    }
  }

  $effect(() => {
    void load();
  });

  async function perform(action: () => Promise<Alias>, message: string): Promise<void> {
    busy = true;
    actionError = null;
    try {
      apply(await action());
      toasts.success(message);
      await refresh();
    } catch (caught) {
      actionError = caught;
    } finally {
      busy = false;
    }
  }

  async function renewAndCopy(): Promise<void> {
    if (!alias) return;
    busy = true;
    actionError = null;
    try {
      apply(await session.client.renewAlias(alias.id));
      await copyText(alias.address);
      toasts.success("Renewed and copied the address");
      await refresh();
    } catch (caught) {
      actionError = caught;
    } finally {
      busy = false;
    }
  }

  async function disable(): Promise<void> {
    if (!alias) return;
    const confirmed = await confirm.ask({
      title: "Disable alias?",
      message: "Inbound mail to a disabled alias is quarantined until it is enabled again.",
      confirmLabel: "Disable",
      danger: true,
    });
    if (!confirmed) return;
    await perform(() => session.client.disableAlias(alias!.id), "Alias disabled");
  }

  async function removeExpiry(): Promise<void> {
    if (!alias) return;
    const confirmed = await confirm.ask({
      title: "Remove expiry?",
      message: "The alias will no longer expire until a new expiry is set.",
      confirmLabel: "Remove expiry",
    });
    if (!confirmed) return;
    await perform(() => session.client.removeAliasExpiry(alias!.id), "Expiry removed");
  }

  async function saveEdits(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!alias) return;
    await perform(
      () =>
        session.client.updateAlias(alias!.id, {
          label: editLabel.trim() || null,
          purpose: editPurpose.trim() || null,
          renewOnOutbound: editRenew,
        }),
      "Alias updated",
    );
  }

  async function setExpiry(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!alias || !expiryInput) return;
    await perform(
      () => session.client.setAliasExpiry(alias!.id, new Date(expiryInput).toISOString()),
      "Expiry updated",
    );
  }

  async function recoverMessage(item: QuarantineResponse, renew: boolean): Promise<void> {
    busy = true;
    actionError = null;
    try {
      await session.client.recoverQuarantine(item.messageId, { renew, enable: renew });
      toasts.success(renew ? "Message recovered and alias renewed" : "Message recovered");
      await refresh();
    } catch (caught) {
      actionError = caught;
    } finally {
      busy = false;
    }
  }

  async function deleteMessage(item: QuarantineResponse): Promise<void> {
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
      await refresh();
    } catch (caught) {
      actionError = caught;
    } finally {
      busy = false;
    }
  }

  async function replyTo(item: QuarantineResponse): Promise<void> {
    if (item.status === "quarantined" || item.status === "recovering") {
      const confirmed = await confirm.ask({
        title: "Recover before replying?",
        message: "Replying requires recovering the message and renewing the alias first.",
        confirmLabel: "Recover and renew",
      });
      if (!confirmed) return;
      try {
        await session.client.recoverQuarantine(item.messageId, { renew: true, enable: true });
        toasts.success("Message recovered and alias renewed");
        await refresh();
      } catch (caught) {
        actionError = caught;
        return;
      }
    }
    replyTarget = { id: item.messageId, quarantined: false };
  }
</script>

<svelte:head><title>Alias · Wickmail</title></svelte:head>

<section class="page">
  <p>
    <button type="button" class="link" onclick={() => router.navigate("/")}>← All aliases</button>
  </p>

  {#if loading}
    <Spinner label="Loading alias" />
  {:else if error}
    <ErrorBanner {error} onRetry={load} />
  {:else if alias}
    <header class="page-header detail-header">
      <div>
        <h1>{alias.label ?? "Untitled alias"}</h1>
        <p class="address address-large">{alias.address}</p>
        <p>
          <StatusBadge state={alias.state} />
          <span class="muted">{describeAlias(alias, now)}</span>
        </p>
      </div>
      <div class="actions">
        <CopyButton value={alias.address} label="Copy" />
        <ShareButton title="Wickmail alias" text={alias.address} />
        <button type="button" class="button" onclick={renewAndCopy} disabled={busy}>
          Renew &amp; copy
        </button>
      </div>
    </header>

    {#if actionError}
      <ErrorBanner error={actionError} />
    {/if}

    <div class="detail-grid">
      <section class="panel" aria-labelledby="status-heading">
        <h2 id="status-heading">Status</h2>
        <dl class="definition">
          <dt>State</dt>
          <dd><StatusBadge state={alias.state} /></dd>
          <dt>Expiry</dt>
          <dd>
            {alias.expiresAt ? formatAbsolute(alias.expiresAt) : "No expiry"}
            <span class="muted">({describeAlias(alias, now)})</span>
          </dd>
          <dt>Created</dt>
          <dd>{formatAbsolute(alias.createdAt)}</dd>
          <dt>Last used</dt>
          <dd>
            {formatRelative(alias.lastUsedAt, now)}
            <span class="muted">({formatAbsolute(alias.lastUsedAt)})</span>
          </dd>
          <dt>Lease duration</dt>
          <dd>{formatDuration(alias.leaseSeconds)}</dd>
          <dt>Outbound renewal</dt>
          <dd>
            {alias.renewOnOutbound ? "Replies renew this alias" : "Replies do not renew this alias"}
          </dd>
        </dl>
        <p class="muted">Inbound mail does not renew an alias.</p>
      </section>

      <section class="panel" aria-labelledby="manage-heading">
        <h2 id="manage-heading">Manage</h2>
        <div class="actions">
          <button
            type="button"
            class="button"
            onclick={() => perform(() => session.client.renewAlias(alias!.id), "Alias renewed")}
            disabled={busy}>Renew</button
          >
          <button
            type="button"
            class="button"
            onclick={() => perform(() => session.client.extendAlias(alias!.id), "Alias extended")}
            disabled={busy}>Extend</button
          >
          {#if alias.state === "disabled"}
            <button
              type="button"
              class="button button-primary"
              onclick={() => perform(() => session.client.enableAlias(alias!.id), "Alias enabled")}
              disabled={busy}>Enable</button
            >
          {:else}
            <button type="button" class="button button-danger" onclick={disable} disabled={busy}>
              Disable
            </button>
          {/if}
          {#if alias.expiresAt}
            <button type="button" class="button" onclick={removeExpiry} disabled={busy}>
              Remove expiry
            </button>
          {/if}
        </div>

        <form onsubmit={setExpiry} class="stack">
          <label class="field">
            <span>Set an exact expiry</span>
            <input type="datetime-local" bind:value={expiryInput} />
          </label>
          <button type="submit" class="button" disabled={busy || !expiryInput}> Set expiry </button>
        </form>
      </section>

      <section class="panel" aria-labelledby="edit-heading">
        <h2 id="edit-heading">Label and policy</h2>
        <form onsubmit={saveEdits} class="stack">
          <label class="field">
            <span>Label</span>
            <input type="text" bind:value={editLabel} placeholder="Example Store" />
          </label>
          <label class="field">
            <span>Purpose</span>
            <input type="text" bind:value={editPurpose} placeholder="order #1234" />
          </label>
          <label class="choice">
            <input type="checkbox" bind:checked={editRenew} />
            Renew when you reply as this alias
          </label>
          <button type="submit" class="button button-primary" disabled={busy}>Save changes</button>
        </form>
      </section>
    </div>

    <section class="panel" aria-labelledby="messages-heading">
      <h2 id="messages-heading">Recent messages</h2>
      {#if messages.length === 0}
        <p class="muted">No recent messages for this alias.</p>
      {:else}
        <ul class="record-list">
          {#each messages as message (message.messageId)}
            <li class="record">
              <div>
                <p class="record-title">{message.subject || "(no subject)"}</p>
                <p class="muted">
                  {message.sender} · {formatRelative(message.receivedAt, now)}
                  <span class="muted">({formatAbsolute(message.receivedAt)})</span>
                </p>
              </div>
              <button
                type="button"
                class="button button-small"
                onclick={() => (replyTarget = { id: message.messageId, quarantined: false })}
                >Reply</button
              >
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="panel" aria-labelledby="quarantine-heading">
      <h2 id="quarantine-heading">Quarantined messages</h2>
      {#if quarantine.length === 0}
        <p class="muted">No quarantined messages for this alias.</p>
      {:else}
        <ul class="record-list">
          {#each quarantine as item (item.messageId)}
            <li class="record">
              <div>
                <p class="record-title">{item.subject || "(no subject)"}</p>
                <p class="muted">
                  {item.sender} · received {formatRelative(item.receivedAt, now)} · retained until
                  {formatAbsolute(item.quarantineExpiresAt)}
                </p>
              </div>
              <div class="actions">
                <button
                  type="button"
                  class="button button-small"
                  onclick={() => recoverMessage(item, false)}
                  disabled={busy}>Recover</button
                >
                <button
                  type="button"
                  class="button button-small"
                  onclick={() => recoverMessage(item, true)}
                  disabled={busy}>Recover &amp; renew</button
                >
                <button
                  type="button"
                  class="button button-small"
                  onclick={() => replyTo(item)}
                  disabled={busy}>Reply</button
                >
                <button
                  type="button"
                  class="button button-small button-danger"
                  onclick={() => deleteMessage(item)}
                  disabled={busy}>Delete</button
                >
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="panel" aria-labelledby="events-heading">
      <h2 id="events-heading">Lifecycle</h2>
      {#if events.length === 0}
        <EmptyState title="No lifecycle events" />
      {:else}
        <ol class="timeline">
          {#each events as event (event.id)}
            <li class="timeline-item">
              <span class="timeline-kind">{EVENT_LABELS[event.kind]}</span>
              <span class="muted"
                >{formatAbsolute(event.createdAt)} · {formatRelative(event.createdAt, now)}</span
              >
            </li>
          {/each}
        </ol>
      {/if}
    </section>
  {:else}
    <EmptyState title="Alias not found" description="It may have been deleted." />
  {/if}
</section>

{#if replyTarget}
  <ReplyComposerDialog
    messageId={replyTarget.id}
    quarantined={replyTarget.quarantined}
    onClose={() => (replyTarget = null)}
    onSent={refresh}
  />
{/if}
