<script lang="ts">
  let { title, message, confirmLabel = 'Confirm', onconfirm, oncancel }:
    { title: string; message: string; confirmLabel?: string; onconfirm: () => void; oncancel: () => void } = $props();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') oncancel();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onclick={oncancel} onkeydown={handleKeydown}>
  <div
    class="bg-(--color-surface) rounded-xl shadow-xl border border-(--color-border) p-6 w-80 max-w-[90vw]"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    <h3 class="text-base font-semibold mb-2">{title}</h3>
    <p class="text-sm text-(--color-text-secondary) mb-5">{message}</p>
    <div class="flex justify-end gap-2">
      <button
        class="px-3 py-1.5 text-sm rounded-lg border border-(--color-border) hover:bg-(--color-surface-hover) transition-colors"
        onclick={oncancel}
      >
        Cancel
      </button>
      <button
        class="px-3 py-1.5 text-sm rounded-lg bg-(--color-offline) text-white hover:opacity-90 transition-opacity"
        onclick={onconfirm}
      >
        {confirmLabel}
      </button>
    </div>
  </div>
</div>

