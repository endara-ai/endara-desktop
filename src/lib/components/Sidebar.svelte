<script lang="ts">
  import { groupedEndpoints, relayPort } from '$lib/stores';
  import SearchBar from './SearchBar.svelte';
  import EndpointRow from './EndpointRow.svelte';
  import AddEndpointModal from './AddEndpointModal.svelte';

  let searchBar: SearchBar | undefined = $state();
  let showAddModal = $state(false);
  let copied = $state(false);

  const RELAY_MCP_URL = $derived(`http://localhost:${$relayPort}/mcp`);

  const healthLabels: Record<string, string> = {
    healthy: '● Healthy',
    degraded: '◐ Degraded',
    error: '⚠ Error',
    failed: '⚠ Failed',
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

  function copyUrl(text: string) {
    navigator.clipboard.writeText(text);
    copied = true;
    setTimeout(() => copied = false, 2000);
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<aside class="w-60 h-full flex flex-col border-r border-(--border) bg-(--side-bg)">
  <div class="p-3 border-b border-(--border) flex items-center gap-2">
    <div class="flex-1 min-w-0">
      <SearchBar bind:this={searchBar} />
    </div>
    <button
      class="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg border border-(--border) hover:bg-(--hover-bg) transition-colors text-(--fg2) hover:text-(--fg1)"
      onclick={() => showAddModal = true}
      title="Add server"
    >
      <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
      </svg>
    </button>
  </div>

  <div class="flex-1 overflow-y-auto p-2">
    {#each Object.entries($groupedEndpoints) as [health, eps]}
      {#if eps.length > 0}
        <div>
          <div class="text-[11px] font-semibold uppercase tracking-[0.1em] text-(--fg3) px-2 pt-2 pb-1">
            {healthLabels[health] ?? health}
          </div>
          <div class="space-y-0.5">
            {#each eps as endpoint (endpoint.name)}
              <EndpointRow {endpoint} />
            {/each}
          </div>
        </div>
      {/if}
    {/each}
  </div>

  <div class="border-t border-(--border) p-3 bg-(--side-bg)">
    <div class="text-[11px] font-semibold uppercase tracking-[0.1em] text-(--fg3) mb-1.5">
      Relay MCP URL
    </div>
    <div class="flex items-center gap-1.5">
      <code class="min-w-0 flex-1 truncate rounded border border-(--border) bg-(--surface) px-2 py-1 text-[11px] font-mono text-(--accent)">
        {RELAY_MCP_URL}
      </code>
      <button
        class="shrink-0 rounded border border-(--border) bg-(--surface) px-2 py-1 text-[11px] text-(--fg2) hover:bg-(--hover-bg) hover:text-(--fg1) transition-colors"
        onclick={() => copyUrl(RELAY_MCP_URL)}
        title="Copy relay MCP URL"
      >
        {copied ? '✓' : 'Copy'}
      </button>
    </div>
  </div>

  {#if showAddModal}
    <AddEndpointModal onclose={() => showAddModal = false} />
  {/if}
</aside>

