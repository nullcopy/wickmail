<script lang="ts">
  import { session } from "../lib/session.svelte";
  import { router } from "../lib/router.svelte";
  import ErrorBanner from "../components/ErrorBanner.svelte";

  let setupToken = $state("");
  let password = $state("");
  let confirmation = $state("");
  let busy = $state(false);
  let error = $state<unknown>(null);

  const mismatch = $derived(confirmation !== "" && password !== confirmation);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy || mismatch) return;
    busy = true;
    error = null;
    try {
      await session.client.completeSetup(setupToken, password);
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
    <h1>Complete setup</h1>
    <p class="muted">
      Enter the single-use setup token printed by the bootstrap command and choose a management
      password.
    </p>
    <form onsubmit={submit} class="stack">
      <label class="field">
        <span>Setup token</span>
        <input type="text" bind:value={setupToken} autocomplete="off" required />
      </label>
      <label class="field">
        <span>Password</span>
        <input type="password" bind:value={password} autocomplete="new-password" required />
      </label>
      <label class="field">
        <span>Confirm password</span>
        <input
          type="password"
          bind:value={confirmation}
          autocomplete="new-password"
          aria-invalid={mismatch}
          required
        />
      </label>
      {#if mismatch}
        <p class="field-error" role="alert">The passwords do not match.</p>
      {/if}
      {#if error}
        <ErrorBanner {error} />
      {/if}
      <div class="actions">
        <button type="button" class="button" onclick={() => router.navigate("/")}>Back</button>
        <button type="submit" class="button button-primary" disabled={busy || mismatch}>
          {busy ? "Setting up…" : "Set up"}
        </button>
      </div>
    </form>
  </div>
</main>
