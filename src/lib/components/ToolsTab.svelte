<script lang="ts">
  import type { Tool } from '$lib/types';
  import { selectedEndpoint } from '$lib/stores';
  import { getEndpointTools } from '$lib/api';
  import { mockTools } from '$lib/mock';

  let tools: Tool[] = $state([]);
  let loading = $state(true);
  let error = $state('');
  let toolSearch = $state('');
  let expandedTool: string | null = $state(null);

  $effect(() => {
    const name = $selectedEndpoint;
    if (!name) return;
    loading = true;
    error = '';
    getEndpointTools(name)
      .then((t) => { tools = t; })
      .catch(() => { tools = mockTools; })
      .finally(() => { loading = false; });
  });

  let filteredTools = $derived(
    toolSearch
      ? tools.filter((t) => t.name.toLowerCase().includes(toolSearch.toLowerCase()))
      : tools
  );

  function toggleExpand(name: string) {
    expandedTool = expandedTool === name ? null : name;
  }
</script>

<div class="p-4 space-y-3">
  <input
    type="text"
    placeholder="Filter tools…"
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
    {#each filteredTools as tool (tool.name)}
      <button
        class="w-full text-left p-3 rounded-lg border border-(--color-border) hover:bg-(--color-surface-hover) transition-colors"
        onclick={() => toggleExpand(tool.name)}
      >
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium font-mono">{tool.name}</span>
          <svg class="w-4 h-4 text-(--color-text-secondary) transition-transform {expandedTool === tool.name ? 'rotate-180' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
        {#if tool.description}
          <div class="text-xs text-(--color-text-secondary) mt-1">{tool.description}</div>
        {/if}
        {#if expandedTool === tool.name && tool.inputSchema}
          <pre class="mt-2 p-2 text-xs font-mono bg-(--color-surface-alt) rounded overflow-x-auto">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
        {/if}
      </button>
    {/each}
    {#if filteredTools.length === 0}
      <div class="text-sm text-(--color-text-secondary) text-center py-6">No tools found</div>
    {/if}
  {/if}
</div>

