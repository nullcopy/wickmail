<script lang="ts">
  import type { AliasState } from "@wickmail/core";

  interface Props {
    state: AliasState;
  }

  let { state }: Props = $props();

  const labels: Record<AliasState, string> = {
    active: "Active",
    expired: "Expired",
    disabled: "Disabled",
  };
</script>

<span class="badge badge-{state}">{labels[state]}</span>
