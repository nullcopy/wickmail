<script lang="ts">
  import { session } from "../lib/session.svelte";
  import { router } from "../lib/router.svelte";
  import ErrorBanner from "../components/ErrorBanner.svelte";

  let mode = $state<"password" | "token">("password");
  let password = $state("");
  let token = $state("");
  let busy = $state(false);
  let error = $state<unknown>(null);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    busy = true;
    error = null;
    try {
      if (mode === "token") {
        await session.loginWithToken(token.trim());
      } else {
        await session.login(password);
      }
      password = "";
      token = "";
    } catch (caught) {
      error = caught;
    } finally {
      busy = false;
    }
  }

  function toggleMode(): void {
    mode = mode === "password" ? "token" : "password";
    error = null;
  }
</script>

<main class="auth">
  <div class="auth-card">
    <h1>Wickmail</h1>
    <p class="muted">Sign in to manage aliases, quarantine, and replies.</p>
    <form onsubmit={submit} class="stack">
      {#if mode === "password"}
        <label class="field">
          <span>Password</span>
          <input type="password" bind:value={password} autocomplete="current-password" required />
        </label>
      {:else}
        <label class="field">
          <span>API token</span>
          <input
            type="password"
            bind:value={token}
            autocomplete="off"
            placeholder="wmk_…"
            required
          />
        </label>
        <p class="muted">The token is kept in memory for this tab only and is never stored.</p>
      {/if}
      {#if error}
        <ErrorBanner {error} />
      {/if}
      <button type="submit" class="button button-primary" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
    <button type="button" class="link" onclick={toggleMode}>
      {mode === "password" ? "Use an API token instead" : "Use the password instead"}
    </button>
    <p class="muted">
      First run?
      <button type="button" class="link" onclick={() => router.navigate("/setup")}
        >Complete setup</button
      >. Locked out?
      <button type="button" class="link" onclick={() => router.navigate("/recover")}
        >Recover the account</button
      >.
    </p>
  </div>
</main>
