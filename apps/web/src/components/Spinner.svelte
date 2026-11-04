<script lang="ts">
  interface Props {
    label?: string;
  }

  let { label = "Loading" }: Props = $props();
</script>

<p class="status" role="status" aria-live="polite">
  <span class="spinner" aria-hidden="true"></span>
  <span>{label}…</span>
</p>
