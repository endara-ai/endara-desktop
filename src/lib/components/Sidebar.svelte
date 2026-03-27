<script lang="ts">
  import { groupedEndpoints, selectedEndpoint } from '$lib/stores';
  import SearchBar from './SearchBar.svelte';
  import EndpointRow from './EndpointRow.svelte';

  let searchBar: SearchBar | undefined = $state();

  const healthLabels: Record<string, string> = {
    healthy: '● Healthy',
    degraded: '◐ Degraded',
    offline: '○ Offline',
    unknown: '? Unknown',
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
  <div class="p-3 border-b border-(--color-border)">
    <div class="text-sm font-semibold mb-2 text-(--color-text)">Endara</div>
    <SearchBar bind:this={searchBar} />
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
</aside>

