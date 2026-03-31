<script lang="ts">
  import { groupedEndpoints, selectedEndpoint } from '$lib/stores';
  import SearchBar from './SearchBar.svelte';
  import EndpointRow from './EndpointRow.svelte';
  import AddEndpointModal from './AddEndpointModal.svelte';

  let searchBar: SearchBar | undefined = $state();
  let showAddModal = $state(false);

  const healthLabels: Record<string, string> = {
    healthy: '● Healthy',
    degraded: '◐ Degraded',
    error: '⚠ Error',
    offline: '○ Offline',
    unknown: '? Unknown',
    disabled: '⏸ Disabled',
  };

  export function focusSearch() {
    searchBar?.focus();
  }

  function handleKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      searchBar?.focus();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<aside class="w-60 h-full flex flex-col border-r border-(--color-border) bg-(--color-surface-alt)">
  <div class="p-3 border-b border-(--color-border) flex items-center gap-2">
    <div class="flex-1 min-w-0">
      <SearchBar bind:this={searchBar} />
    </div>
    <button
      class="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg border border-(--color-border) hover:bg-(--color-surface-hover) transition-colors text-(--color-text-secondary) hover:text-(--color-text)"
      onclick={() => showAddModal = true}
      title="Add server"
    >
      <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
      </svg>
    </button>
  </div>

  <div class="flex-1 overflow-y-auto p-2 space-y-3">
    {#each Object.entries($groupedEndpoints) as [health, eps]}
      {#if eps.length > 0}
        <div>
          <div class="text-[11px] font-semibold uppercase tracking-wider text-(--color-text-secondary) px-2 mb-1">
            {healthLabels[health] ?? health}
          </div>
          {#each eps as endpoint (endpoint.name)}
            <EndpointRow {endpoint} />
          {/each}
        </div>
      {/if}
    {/each}
  </div>

  {#if showAddModal}
    <AddEndpointModal onclose={() => showAddModal = false} />
  {/if}
</aside>

