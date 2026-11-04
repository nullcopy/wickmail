<script lang="ts">
  import type { Alias, ExpiryRequest } from "@wickmail/core";
  import { untrack } from "svelte";
  import { session } from "../lib/session.svelte";
  import { aliasPath, router } from "../lib/router.svelte";
  import { LEASE_PRESETS } from "../lib/preferences";
  import CopyButton from "./CopyButton.svelte";
  import ShareButton from "./ShareButton.svelte";
  import ErrorBanner from "./ErrorBanner.svelte";

  interface Props {
    onClose: () => void;
    onCreated?: (alias: Alias) => void;
    /** Suggested label, for example from a shared link. */
    initialLabel?: string;
  }

  let { onClose, onCreated, initialLabel = "" }: Props = $props();

  type Preset = "24h" | "7d" | "30d" | "custom" | "never";

  function presetFor(seconds: number | null): Preset {
    if (seconds === null) return "never";
    if (seconds === LEASE_PRESETS[0].seconds) return "24h";
    if (seconds === LEASE_PRESETS[1].seconds) return "7d";
    if (seconds === LEASE_PRESETS[2].seconds) return "30d";
    return "custom";
  }

  let label = $state(untrack(() => initialLabel));
  let purpose = $state("");
  let preset = $state<Preset>(presetFor(session.preferences.defaultLeaseSeconds));
  let customExpiry = $state("");
  let renewOnOutbound = $state(session.preferences.defaultRenewOnOutbound);
  let busy = $state(false);
  let error = $state<unknown>(null);
  let created = $state<Alias | null>(null);
  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => {
    if (dialog && !dialog.open) dialog.showModal();
  });

  const canSubmit = $derived(preset !== "custom" || customExpiry !== "");

  function expiryRequest(): ExpiryRequest {
    switch (preset) {
      case "24h":
        return { mode: "lease", seconds: LEASE_PRESETS[0].seconds };
      case "7d":
        return { mode: "lease", seconds: LEASE_PRESETS[1].seconds };
      case "30d":
        return { mode: "lease", seconds: LEASE_PRESETS[2].seconds };
      case "never":
        return { mode: "never" };
      case "custom":
        return { mode: "absolute", expiresAt: new Date(customExpiry).toISOString() };
    }
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy || !canSubmit) return;
    busy = true;
    error = null;
    try {
      const alias = await session.client.createAlias({
        label: label.trim() || null,
        purpose: purpose.trim() || null,
        expiry: expiryRequest(),
        renewOnOutbound,
      });
      created = alias;
      onCreated?.(alias);
    } catch (caught) {
      error = caught;
    } finally {
      busy = false;
    }
  }

  function openAlias(): void {
    if (!created) return;
    router.navigate(aliasPath(created.id));
    onClose();
  }

  function onCancel(event: Event): void {
    event.preventDefault();
    onClose();
  }
</script>

<dialog
  bind:this={dialog}
  class="modal modal-wide"
  aria-labelledby="generate-title"
  oncancel={onCancel}
>
  {#if created}
    <h2 id="generate-title">Alias created</h2>
    <p class="muted">The server generated and stored this address. Copy or share it now.</p>
    <p class="address address-large">{created.address}</p>
    <div class="actions">
      <CopyButton value={created.address} label="Copy address" />
      <ShareButton title="Wickmail alias" text={created.address} />
      <button type="button" class="button" onclick={openAlias}>Open alias</button>
      <button type="button" class="button button-quiet" onclick={onClose}>Done</button>
    </div>
  {:else}
    <h2 id="generate-title">Generate alias</h2>
    <form onsubmit={submit} class="stack">
      <label class="field">
        <span>Label (optional)</span>
        <input type="text" bind:value={label} placeholder="Example Store" />
      </label>
      <label class="field">
        <span>Purpose (optional)</span>
        <input type="text" bind:value={purpose} placeholder="order #1234" />
      </label>
      <fieldset class="field">
        <legend>Expiration</legend>
        <label class="choice"><input type="radio" value="24h" bind:group={preset} /> 24 hours</label
        >
        <label class="choice"><input type="radio" value="7d" bind:group={preset} /> 7 days</label>
        <label class="choice"><input type="radio" value="30d" bind:group={preset} /> 30 days</label>
        <label class="choice"
          ><input type="radio" value="custom" bind:group={preset} /> Custom</label
        >
        <label class="choice"
          ><input type="radio" value="never" bind:group={preset} /> No expiry</label
        >
      </fieldset>
      {#if preset === "custom"}
        <label class="field">
          <span>Expires at</span>
          <input type="datetime-local" bind:value={customExpiry} required />
        </label>
      {/if}
      <label class="choice">
        <input type="checkbox" bind:checked={renewOnOutbound} />
        Renew when you reply as this alias
      </label>
      <p class="muted">Inbound mail does not renew an alias.</p>

      {#if error}
        <ErrorBanner {error} />
      {/if}

      <div class="modal-actions">
        <button type="button" class="button" onclick={onClose}>Cancel</button>
        <button type="submit" class="button button-primary" disabled={busy || !canSubmit}>
          {busy ? "Generating…" : "Generate alias"}
        </button>
      </div>
    </form>
  {/if}
</dialog>
