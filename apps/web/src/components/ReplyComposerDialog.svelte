<script lang="ts">
  import type { ReplyContext, ReplyResponse } from "@wickmail/core";
  import { session } from "../lib/session.svelte";
  import {
    defaultIdentityKey,
    findIdentity,
    identityAlternatives,
    identityKey,
    identityLabel,
    identitySelection,
    replyErrorGuidance,
    replySubject,
    requiresIdentityChoice,
    type ReplyErrorGuidance,
  } from "../lib/reply";
  import { formatAbsolute } from "../lib/format";
  import Spinner from "./Spinner.svelte";
  import ErrorBanner from "./ErrorBanner.svelte";

  interface Props {
    messageId: string;
    quarantined?: boolean;
    onRecover?: () => Promise<void>;
    onClose: () => void;
    onSent?: (response: ReplyResponse) => void;
  }

  let { messageId, quarantined = false, onRecover, onClose, onSent }: Props = $props();

  let context = $state<ReplyContext | null>(null);
  let loading = $state(true);
  let loadError = $state<unknown>(null);
  let selectedKey = $state<string | null>(null);
  let body = $state("");
  let includeQuote = $state(true);
  let busy = $state(false);
  let sendError = $state<unknown>(null);
  let guidance = $state<ReplyErrorGuidance | null>(null);
  let sent = $state<ReplyResponse | null>(null);
  let recovered = $state(false);
  let recovering = $state(false);
  let dialog: HTMLDialogElement | undefined = $state();

  const held = $derived(quarantined && !recovered);

  $effect(() => {
    if (dialog && !dialog.open) dialog.showModal();
  });

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      const loaded = await session.client.getReplyContext(messageId);
      context = loaded;
      selectedKey = defaultIdentityKey(loaded);
    } catch (caught) {
      loadError = caught;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  const mustChoose = $derived(
    context !== null && requiresIdentityChoice(context) && selectedKey === null,
  );

  const quoted = $derived(
    context && context.text
      ? context.text
          .split(/\r?\n/)
          .map((line) => `> ${line}`)
          .join("\n")
      : "",
  );

  function quote(): string {
    return quoted;
  }

  async function recover(): Promise<void> {
    if (!onRecover) return;
    recovering = true;
    sendError = null;
    try {
      await onRecover();
      recovered = true;
    } catch (caught) {
      sendError = caught;
      guidance = replyErrorGuidance(caught);
    } finally {
      recovering = false;
    }
  }

  async function send(): Promise<void> {
    if (!context || busy || mustChoose || body.trim() === "") return;
    busy = true;
    sendError = null;
    guidance = null;
    try {
      const option = findIdentity(context, selectedKey);
      const response = await session.client.sendReply(messageId, {
        ...identitySelection(option),
        body,
        quotedText: includeQuote && quoted ? quote() : null,
      });
      sent = response;
      onSent?.(response);
    } catch (caught) {
      sendError = caught;
      guidance = replyErrorGuidance(caught, findIdentity(context, selectedKey));
    } finally {
      busy = false;
    }
  }

  function onCancel(event: Event): void {
    event.preventDefault();
    onClose();
  }
</script>

<dialog
  bind:this={dialog}
  class="modal modal-wide"
  aria-labelledby="reply-title"
  oncancel={onCancel}
>
  <h2 id="reply-title">Reply</h2>

  {#if loading}
    <Spinner label="Loading reply context" />
  {:else if loadError}
    <ErrorBanner error={loadError} onRetry={load} />
    <div class="modal-actions">
      <button type="button" class="button" onclick={onClose}>Close</button>
    </div>
  {:else if sent}
    <div class="banner banner-success" role="status">
      <strong>Reply queued</strong>
      <p>
        Sent as {sent.identity.address}{sent.renewed ? ", and the alias lease was renewed." : "."}
      </p>
    </div>
    <p class="muted">
      {#if sent.expiresAt}
        New expiry: {formatAbsolute(sent.expiresAt)}
      {:else}
        The alias has no expiry.
      {/if}
    </p>
    <div class="modal-actions">
      <button type="button" class="button button-primary" onclick={onClose}>Done</button>
    </div>
  {:else if context}
    {#if held}
      <div class="banner banner-warning" role="alert">
        <strong>This message is quarantined</strong>
        <p>Recover the message and renew the alias before replying.</p>
        {#if onRecover}
          <button type="button" class="button" onclick={recover} disabled={recovering}>
            {recovering ? "Recovering…" : "Recover and renew"}
          </button>
        {/if}
      </div>
    {/if}

    <form
      onsubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      class="stack"
    >
      <label class="field">
        <span>To</span>
        <input type="text" value={context.from ?? "unknown sender"} readonly />
      </label>
      <label class="field">
        <span>Subject</span>
        <input type="text" value={replySubject(context.subject)} readonly />
      </label>

      {#if context.identity.options.length > 1 || requiresIdentityChoice(context)}
        <fieldset class="field">
          <legend>
            Send as
            {#if requiresIdentityChoice(context)}
              <span class="muted">(choose an alias)</span>
            {/if}
          </legend>
          {#each context.identity.options as option (identityKey(option))}
            <label class="choice">
              <input
                type="radio"
                name="identity"
                value={identityKey(option)}
                bind:group={selectedKey}
              />
              {identityLabel(option)}
            </label>
          {/each}
        </fieldset>
      {:else}
        <p class="field">
          <span>Send as</span>
          <span class="value"
            >{context.identity.selected
              ? identityLabel(context.identity.selected)
              : "Primary"}</span
          >
        </p>
      {/if}

      <label class="field">
        <span>Message</span>
        <textarea bind:value={body} rows="8" placeholder="Write your reply"></textarea>
      </label>
      {#if quoted}
        <label class="choice">
          <input type="checkbox" bind:checked={includeQuote} />
          Include the original message
        </label>
      {/if}

      {#if guidance}
        <div class="banner banner-error" role="alert">
          <strong>{guidance.title}</strong>
          <p>{guidance.detail}</p>
          {#if sendError}
            <ErrorBanner error={sendError} />
          {/if}
        </div>
        {#if sendError && context.identity.options.length > 0}
          <fieldset class="field">
            <legend>Try another identity</legend>
            {#each identityAlternatives(context, findIdentity(context, selectedKey)) as option (identityKey(option))}
              <button
                type="button"
                class="button"
                onclick={() => (selectedKey = identityKey(option))}
              >
                {identityLabel(option)}
              </button>
            {/each}
          </fieldset>
        {/if}
      {/if}

      <div class="modal-actions">
        <button type="button" class="button" onclick={onClose}>Cancel</button>
        <button
          type="submit"
          class="button button-primary"
          disabled={busy || mustChoose || body.trim() === ""}
        >
          {busy ? "Sending…" : "Send reply"}
        </button>
      </div>
    </form>
  {/if}
</dialog>
