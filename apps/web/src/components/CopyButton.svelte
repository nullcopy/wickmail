<script lang="ts">
  import { copyText } from "../lib/clipboard";

  interface Props {
    value: string;
    label?: string;
    copiedLabel?: string;
    small?: boolean;
  }

  let { value, label = "Copy", copiedLabel = "Copied", small = false }: Props = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy(): Promise<void> {
    if (!(await copyText(value))) return;
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 2000);
  }
</script>

<button
  type="button"
  class="button {small ? 'button-small' : 'button-primary'}"
  onclick={copy}
  aria-label="{label}: {value}"
>
  {copied ? copiedLabel : label}
</button>
<span class="visually-hidden" aria-live="polite">{copied ? "Copied to clipboard" : ""}</span>
