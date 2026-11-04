<script lang="ts">
  import { confirm } from "../lib/confirm.svelte";

  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => {
    if (!dialog) return;
    if (confirm.options) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  });

  function onCancel(event: Event): void {
    event.preventDefault();
    confirm.respond(false);
  }
</script>

<dialog bind:this={dialog} class="modal" aria-labelledby="confirm-title" oncancel={onCancel}>
  {#if confirm.options}
    <h2 id="confirm-title">{confirm.options.title}</h2>
    <p>{confirm.options.message}</p>
    <div class="modal-actions">
      <button type="button" class="button" onclick={() => confirm.respond(false)}>
        {confirm.options.cancelLabel ?? "Cancel"}
      </button>
      <button
        type="button"
        class="button {confirm.options.danger ? 'button-danger' : 'button-primary'}"
        onclick={() => confirm.respond(true)}
      >
        {confirm.options.confirmLabel ?? "Confirm"}
      </button>
    </div>
  {/if}
</dialog>
