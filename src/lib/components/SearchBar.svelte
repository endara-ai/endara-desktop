<script lang="ts">
  import { searchQuery } from '$lib/stores';

  let inputEl: HTMLInputElement | undefined = $state();

  export function focus() {
    inputEl?.focus();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      searchQuery.set('');
      inputEl?.blur();
    }
  }
</script>

<div class="relative">
  <svg class="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-(--color-text-secondary)" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
  </svg>
  <input
    bind:this={inputEl}
    type="text"
    placeholder="Search… ⌘K"
    class="w-full pl-8 pr-3 py-1.5 text-sm rounded-lg border border-(--color-border) bg-(--color-surface) text-(--color-text) placeholder:text-(--color-text-secondary) focus:outline-none focus:ring-2 focus:ring-(--color-accent)/40 transition-shadow"
    bind:value={$searchQuery}
    onkeydown={handleKeydown}
  />
</div>

