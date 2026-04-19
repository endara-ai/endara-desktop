<script lang="ts">
  let { title, message, confirmLabel = 'Confirm', onconfirm, oncancel }:
    { title: string; message: string; confirmLabel?: string; onconfirm: () => void; oncancel: () => void } = $props();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') oncancel();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="presentation" onclick={oncancel} onkeydown={handleKeydown}>
  <div
    class="bg-(--surface) rounded-xl shadow-xl border border-(--border) p-6 w-80 max-w-[90vw]"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    <h3 class="text-base font-semibold mb-2">{title}</h3>
    <p class="text-sm text-(--fg2) mb-5">{message}</p>
    <div class="flex justify-end gap-2">
      <button
        class="px-3 py-1.5 text-sm rounded-lg border border-(--border) hover:bg-(--surface-hover) transition-colors"
        onclick={oncancel}
      >
        Cancel
      </button>
      <button
        class="px-3 py-1.5 text-sm rounded-lg bg-(--offline) text-white hover:opacity-90 transition-opacity"
        onclick={onconfirm}
      >
        {confirmLabel}
      </button>
    </div>
  </div>
</div>

