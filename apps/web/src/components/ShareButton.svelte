<script lang="ts">
  interface Props {
    title: string;
    text: string;
    label?: string;
    small?: boolean;
  }

  let { title, text, label = "Share", small = false }: Props = $props();

  let state = $state<"idle" | "shared" | "copied">("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flash(next: "shared" | "copied"): void {
    state = next;
    clearTimeout(timer);
    timer = setTimeout(() => (state = "idle"), 2000);
  }

  async function share(): Promise<void> {
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title, text });
        flash("shared");
        return;
      } catch {
        // The user dismissed the share sheet, or sharing is unavailable.
        return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      flash("copied");
    } catch {
      // Nothing else to do without clipboard access.
    }
  }
</script>

<button type="button" class="button {small ? 'button-small' : ''}" onclick={share}>
  {state === "shared" ? "Shared" : state === "copied" ? "Copied" : label}
</button>
<span class="visually-hidden" aria-live="polite"
  >{state === "copied" ? "Copied to clipboard" : ""}</span
>
