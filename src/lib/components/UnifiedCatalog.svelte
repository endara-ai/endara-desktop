<script lang="ts">
  import type { CatalogEntry } from '$lib/types';
  import { selectedEndpoint, activeTopLevelTab, activeTab } from '$lib/stores';
  import { getCatalog } from '$lib/api';

  let catalog: CatalogEntry[] = $state([]);
  let loading = $state(true);
  let error = $state('');
  let toolSearch = $state('');
  let expandedTool: string | null = $state(null);
  let pollInterval: ReturnType<typeof setInterval> | undefined;

  async function fetchCatalog() {
    try {
      catalog = await getCatalog();
      error = '';
    } catch (e) {
      catalog = [];
      error = 'Failed to load catalog';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    fetchCatalog();
    pollInterval = setInterval(fetchCatalog, 2000);
    return () => {
      if (pollInterval) clearInterval(pollInterval);
    };
  });

  let filteredCatalog = $derived(
    toolSearch
      ? catalog.filter(
          (t) =>
            t.name.toLowerCase().includes(toolSearch.toLowerCase()) ||
            (t.description ?? '').toLowerCase().includes(toolSearch.toLowerCase())
        )
      : catalog
  );

  function toggleExpand(name: string) {
    expandedTool = expandedTool === name ? null : name;
  }

  function navigateToEndpoint(endpointName: string) {
    selectedEndpoint.set(endpointName);
    activeTab.set('tools');
    activeTopLevelTab.set('servers');
  }
</script>

<div class="h-full overflow-y-auto p-4 space-y-3">
  <input
    type="text"
    placeholder="Search tools…"
    class="w-full px-3 py-1.5 text-sm rounded-lg border border-(--color-border) bg-(--color-surface) focus:outline-none focus:ring-2 focus:ring-(--color-accent)/40"
    bind:value={toolSearch}
  />

  {#if loading}
    <div class="space-y-2">
      {#each [1, 2, 3] as _}
        <div class="h-10 rounded-lg bg-(--color-surface-hover) animate-pulse"></div>
      {/each}
    </div>
  {:else if error}
    <div class="text-sm text-(--color-offline)">{error}</div>
  {:else}
    {#each filteredCatalog as entry (entry.name)}
      <div
        class="w-full text-left p-3 rounded-lg border border-(--color-border) hover:bg-(--color-surface-hover) transition-colors cursor-pointer {entry.available ? '' : 'opacity-50'}"
        onclick={() => toggleExpand(entry.name)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(entry.name); } }}
        role="button"
        tabindex="0"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="text-sm font-medium font-mono truncate">{entry.name}</span>
          <div class="flex items-center gap-2 shrink-0">
            <span class="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-(--color-surface-alt) text-(--color-text-secondary)">{entry.endpoint}</span>
            {#if !entry.available}
              <span class="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">⚠️ Unavailable</span>
            {:else}
              <span class="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">Available</span>
            {/if}
            {#if entry.annotations?.readOnlyHint === true}
              <span class="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">Read-only</span>
            {/if}
            {#if entry.annotations?.destructiveHint === true}
              <span class="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">Destructive</span>
            {/if}
            <button
              class="p-0.5 rounded hover:bg-(--color-surface-hover)"
              onclick={(e) => { e.stopPropagation(); navigateToEndpoint(entry.endpoint); }}
              title="Jump to endpoint"
            >
              <svg class="w-4 h-4 text-(--color-text-secondary)" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>
            <button
              class="p-0.5 rounded hover:bg-(--color-surface-hover)"
              onclick={(e) => { e.stopPropagation(); toggleExpand(entry.name); }}
              title="Show details"
            >
              <svg class="w-4 h-4 text-(--color-text-secondary) transition-transform {expandedTool === entry.name ? 'rotate-180' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>
        {#if entry.description}
          <div class="text-xs text-(--color-text-secondary) mt-1">{entry.description}</div>
        {/if}
        {#if expandedTool === entry.name}
          {#if entry.inputSchema}
            <div class="mt-2">
              <div class="text-xs font-medium text-(--color-text-secondary) mb-1">Input Schema</div>
              <pre class="p-2 text-xs font-mono bg-(--color-surface-alt) rounded overflow-x-auto">{JSON.stringify(entry.inputSchema, null, 2)}</pre>
            </div>
          {/if}
          {#if entry.annotations}
            <div class="mt-2">
              <div class="text-xs font-medium text-(--color-text-secondary) mb-1">Annotations</div>
              <pre class="p-2 text-xs font-mono bg-(--color-surface-alt) rounded overflow-x-auto">{JSON.stringify(entry.annotations, null, 2)}</pre>
            </div>
          {/if}
        {/if}
      </div>
    {/each}
    {#if filteredCatalog.length === 0}
      <div class="text-sm text-(--color-text-secondary) text-center py-6">No tools found</div>
    {/if}
  {/if}
</div>

