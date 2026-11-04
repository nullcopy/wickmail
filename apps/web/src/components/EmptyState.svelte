<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    description?: string;
    children?: Snippet;
  }

  let { title, description = "", children }: Props = $props();
</script>

<div class="empty-state">
  <h3>{title}</h3>
  {#if description}
    <p>{description}</p>
  {/if}
  {#if children}
    <div class="empty-actions">{@render children()}</div>
  {/if}
</div>
