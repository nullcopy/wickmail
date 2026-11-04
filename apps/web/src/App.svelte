<script lang="ts">
  import { onMount } from "svelte";
  import { session } from "./lib/session.svelte";
  import { router } from "./lib/router.svelte";
  import Login from "./routes/Login.svelte";
  import Setup from "./routes/Setup.svelte";
  import Recover from "./routes/Recover.svelte";
  import Dashboard from "./routes/Dashboard.svelte";
  import AliasDetail from "./routes/AliasDetail.svelte";
  import Quarantine from "./routes/Quarantine.svelte";
  import Messages from "./routes/Messages.svelte";
  import Activity from "./routes/Activity.svelte";
  import Settings from "./routes/Settings.svelte";
  import Spinner from "./components/Spinner.svelte";
  import ErrorBanner from "./components/ErrorBanner.svelte";
  import ConfirmDialog from "./components/ConfirmDialog.svelte";
  import Toasts from "./components/Toasts.svelte";

  onMount(() => {
    void session.initialize();
  });

  const navItems = [
    { name: "dashboard", label: "Aliases", path: "/" },
    { name: "quarantine", label: "Quarantine", path: "/quarantine" },
    { name: "messages", label: "Messages", path: "/messages" },
    { name: "activity", label: "Activity", path: "/activity" },
    { name: "settings", label: "Settings", path: "/settings" },
  ] as const;

  const route = $derived(router.route);
  const aliasId = $derived(route.name === "alias" ? route.id : null);

  function go(event: MouseEvent, to: string): void {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    router.navigate(to);
  }
</script>

{#if session.state === "loading"}
  <main class="app-center">
    <Spinner label="Loading Wickmail" />
  </main>
{:else if session.state === "offline"}
  <main class="app-center">
    <ErrorBanner error={session.offlineError} onRetry={() => session.initialize()} />
  </main>
{:else if session.state === "anonymous"}
  {#if route.name === "setup"}
    <Setup />
  {:else if route.name === "recover"}
    <Recover />
  {:else}
    <Login />
  {/if}
{:else}
  <div class="app-shell">
    <a class="skip-link" href="#main">Skip to content</a>
    <header class="app-header">
      <span class="brand">Wickmail</span>
      <nav aria-label="Primary">
        <ul>
          {#each navItems as item (item.name)}
            <li>
              <a
                href={item.path}
                class:active={route.name === item.name}
                aria-current={route.name === item.name ? "page" : undefined}
                onclick={(event) => go(event, item.path)}>{item.label}</a
              >
            </li>
          {/each}
        </ul>
      </nav>
    </header>
    <main id="main" class="app-main">
      {#if aliasId}
        <AliasDetail id={aliasId} />
      {:else if route.name === "quarantine"}
        <Quarantine />
      {:else if route.name === "messages"}
        <Messages />
      {:else if route.name === "activity"}
        <Activity />
      {:else if route.name === "settings"}
        <Settings />
      {:else}
        <Dashboard />
      {/if}
    </main>
  </div>
{/if}

<ConfirmDialog />
<Toasts />
