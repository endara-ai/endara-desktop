<script lang="ts">
  import type { Tool } from '$lib/types';
  import { selectedEndpoint } from '$lib/stores';
  import { getEndpointTools, disableTool, enableTool } from '$lib/api';


  let tools: Tool[] = $state([]);
  let loading = $state(true);
  let error = $state('');
  let toolSearch = $state('');
  let expandedTool: string | null = $state(null);
  let togglingTool: string | null = $state(null);

  $effect(() => {
    const name = $selectedEndpoint;
    if (!name) return;
    loading = true;
    error = '';
    getEndpointTools(name)
      .then((t) => { tools = t; })
      .catch(() => { tools = []; })
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

  async function handleToolToggle(event: Event, tool: Tool) {
    event.stopPropagation();
    const epName = $selectedEndpoint;
    if (!epName || togglingTool) return;
    togglingTool = tool.name;
    try {
      if (tool.disabled) {
        await enableTool(epName, tool.name);
      } else {
        await disableTool(epName, tool.name);
      }
      try {
        tools = await getEndpointTools(epName);
      } catch { /* will be picked up by next load */ }
    } catch { /* ignore */ }
    togglingTool = null;
  }
</script>

<div class="h-full overflow-y-auto p-4 space-y-3">
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
      <div
        class="w-full text-left p-3 rounded-lg border border-(--color-border) hover:bg-(--color-surface-hover) transition-colors cursor-pointer {tool.disabled ? 'opacity-50' : ''}"
        onclick={() => toggleExpand(tool.name)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(tool.name); } }}
        role="button"
        tabindex="0"
      >
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium font-mono">{tool.name}</span>
          <div class="flex items-center gap-2">
            {#if tool.annotations?.readOnlyHint === true}
              <span class="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">Read-only</span>
            {/if}
            {#if tool.annotations?.destructiveHint === true}
              <span class="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">Destructive</span>
            {/if}
            {#if tool.annotations?.idempotentHint === true}
              <span class="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">Idempotent</span>
            {/if}
            {#if tool.annotations?.openWorldHint === true}
              <span class="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">Open-world</span>
            {/if}
            <button
              class="relative w-8 h-4 rounded-full transition-colors {tool.disabled ? 'bg-gray-300 dark:bg-gray-600' : 'bg-green-500'} {togglingTool === tool.name ? 'opacity-50' : ''}"
              onclick={(e) => handleToolToggle(e, tool)}
              disabled={togglingTool === tool.name}
              title={tool.disabled ? 'Enable tool' : 'Disable tool'}
            >
              <span class="absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform {tool.disabled ? '' : 'translate-x-4'}"></span>
            </button>
            <svg class="w-4 h-4 text-(--color-text-secondary) transition-transform {expandedTool === tool.name ? 'rotate-180' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>
        {#if tool.description}
          <div class="text-xs text-(--color-text-secondary) mt-1">
            {tool.description}
            {#if tool.disabled}
              <span class="italic"> (hidden from MCP clients)</span>
            {/if}
          </div>
        {/if}
        {#if expandedTool === tool.name}
          {#if tool.inputSchema}
            <div class="mt-2">
              <div class="text-xs font-medium text-(--color-text-secondary) mb-1">Input Schema</div>
              <pre class="p-2 text-xs font-mono bg-(--color-surface-alt) rounded overflow-x-auto">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
            </div>
          {/if}
          {#if tool.annotations}
            <div class="mt-2">
              <div class="text-xs font-medium text-(--color-text-secondary) mb-1">Annotations</div>
              <pre class="p-2 text-xs font-mono bg-(--color-surface-alt) rounded overflow-x-auto">{JSON.stringify(tool.annotations, null, 2)}</pre>
            </div>
          {/if}
          {#if !tool.inputSchema && !tool.annotations}
            <div class="mt-2 text-xs text-(--color-text-secondary) italic">No schema available</div>
          {/if}
        {/if}
      </div>
    {/each}
    {#if filteredTools.length === 0}
      <div class="text-sm text-(--color-text-secondary) text-center py-6">No tools found</div>
    {/if}
  {/if}
</div>

