<script lang="ts">
  import { session } from "../lib/session.svelte";
  import { router } from "../lib/router.svelte";
  import ErrorBanner from "../components/ErrorBanner.svelte";

  let code = $state("");
  let password = $state("");
  let busy = $state(false);
  let error = $state<unknown>(null);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    busy = true;
    error = null;
    try {
      await session.client.recoverAccount(code, password);
      await session.login(password);
    } catch (caught) {
      error = caught;
    } finally {
      busy = false;
    }
  }
</script>

<main class="auth">
  <div class="auth-card">
    <h1>Recover account</h1>
    <p class="muted">
      Enter a one-time recovery code and a new management password. Recovery codes are printed by
      the server's recovery command.
    </p>
    <form onsubmit={submit} class="stack">
      <label class="field">
        <span>Recovery code</span>
        <input type="text" bind:value={code} autocomplete="off" required />
      </label>
      <label class="field">
        <span>New password</span>
        <input type="password" bind:value={password} autocomplete="new-password" required />
      </label>
      {#if error}
        <ErrorBanner {error} />
      {/if}
      <div class="actions">
        <button type="button" class="button" onclick={() => router.navigate("/")}>Back</button>
        <button type="submit" class="button button-primary" disabled={busy}>
          {busy ? "Recovering…" : "Recover"}
        </button>
      </div>
    </form>
  </div>
</main>
