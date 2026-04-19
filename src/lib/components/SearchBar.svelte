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
  <svg
    class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-(--fg3)"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
  >
    <circle cx="11" cy="11" r="8" />
    <path d="M21 21l-4.3-4.3" stroke-linecap="round" />
  </svg>
  <input
    bind:this={inputEl}
    type="text"
    placeholder="Search… ⌘K"
    class="w-full pl-7 pr-2.5 py-[5px] text-[13px] rounded-lg border border-(--border) bg-(--surface) text-(--fg1) placeholder:text-(--fg3) focus:outline-none focus:border-(--accent) focus:shadow-[0_0_0_3px_var(--accent-tint)] transition-shadow"
    bind:value={$searchQuery}
    onkeydown={handleKeydown}
  />
</div>

