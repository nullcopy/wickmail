<script lang="ts">
  import { API_CONTRACT_VERSION, isActive, type Alias } from "@wickmail/core";

  let alias = $state<Alias>({
    id: "example",
    address: "green.farm@example.com",
    state: "active",
    expiresAt: "2026-01-01T00:00:00Z",
  });

  function toggle(): void {
    alias = { ...alias, state: alias.state === "active" ? "expired" : "active" };
  }
</script>

<main>
  <h1>Wickmail</h1>
  <p>Management console scaffold (API contract {API_CONTRACT_VERSION}).</p>
  <p>{alias.address} is {isActive(alias) ? "active" : "inactive"}.</p>
  <button onclick={toggle}>Toggle state</button>
</main>
