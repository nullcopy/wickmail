<script lang="ts">
  import { API_CONTRACT_VERSION, isActive, type Alias } from "@wickmail/core";

  let alias = $state<Alias>({
    id: "018f9b60-0000-7000-8000-000000000001",
    address: "green.farm@example.com",
    label: "Example Store",
    purpose: null,
    state: "active",
    createdAt: "2026-01-01T00:00:00Z",
    expiresAt: "2026-01-08T00:00:00Z",
    disabledAt: null,
    leaseSeconds: 604800,
    renewOnOutbound: true,
    lastInboundAt: null,
    lastUserActivityAt: null,
    lastUsedAt: "2026-01-01T00:00:00Z",
    policyVersion: 0,
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
