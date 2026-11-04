<script lang="ts">
  import { errorMessage, errorTitle } from "../lib/errors";

  interface Props {
    error: unknown;
    onRetry?: () => void;
    retryLabel?: string;
  }

  let { error, onRetry, retryLabel = "Try again" }: Props = $props();
</script>

<div class="banner banner-error" role="alert">
  <strong>{errorTitle(error)}</strong>
  <p>{errorMessage(error)}</p>
  {#if onRetry}
    <button type="button" class="button" onclick={onRetry}>{retryLabel}</button>
  {/if}
</div>
