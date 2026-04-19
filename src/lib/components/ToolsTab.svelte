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

<div class="dbody">
  <input
    type="text"
    placeholder="Filter tools…"
    class="filter-input"
    bind:value={toolSearch}
  />

  {#if loading}
    <div class="space-y-2">
      {#each [1, 2, 3] as _}
        <div class="h-10 rounded-lg bg-(--surface-hover) animate-pulse"></div>
      {/each}
    </div>
  {:else if error}
    <div class="text-sm text-(--offline)">{error}</div>
  {:else}
    {#each filteredTools as tool (tool.name)}
      <div
        class="tool-row {tool.disabled ? 'opacity-50' : ''}"
        onclick={() => toggleExpand(tool.name)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(tool.name); } }}
        role="button"
        tabindex="0"
      >
        <div class="tool-head">
          <span class="tool-name">{tool.name}</span>
          {#if tool.annotations?.readOnlyHint === true}
            <span class="hint-pill hint-read">Read-only</span>
          {/if}
          {#if tool.annotations?.destructiveHint === true}
            <span class="hint-pill hint-dest">Destructive</span>
          {/if}
          {#if tool.annotations?.idempotentHint === true}
            <span class="hint-pill hint-read">Idempotent</span>
          {/if}
          {#if tool.annotations?.openWorldHint === true}
            <span class="hint-pill hint-dest">Open-world</span>
          {/if}
          <button
            class="tgl tool-tgl {tool.disabled ? 'tgl-off' : ''} {togglingTool === tool.name ? 'opacity-50' : ''}"
            onclick={(e) => handleToolToggle(e, tool)}
            disabled={togglingTool === tool.name}
            title={tool.disabled ? 'Enable tool' : 'Disable tool'}
            aria-label={tool.disabled ? 'Enable tool' : 'Disable tool'}
          ><span></span></button>
          <svg class="w-4 h-4 text-(--fg3) transition-transform {expandedTool === tool.name ? 'rotate-180' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
        {#if tool.description}
          <div class="tool-desc">
            {tool.description}
            {#if tool.disabled}
              <span class="italic"> (hidden from MCP clients)</span>
            {/if}
          </div>
        {/if}
        {#if expandedTool === tool.name}
          {#if tool.inputSchema}
            <div class="mt-2">
              <div class="text-[11px] font-medium text-(--fg2) mb-1">Input Schema</div>
              <pre class="p-2 text-xs font-mono bg-(--surface-alt) rounded overflow-x-auto">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
            </div>
          {/if}
          {#if tool.annotations}
            <div class="mt-2">
              <div class="text-[11px] font-medium text-(--fg2) mb-1">Annotations</div>
              <pre class="p-2 text-xs font-mono bg-(--surface-alt) rounded overflow-x-auto">{JSON.stringify(tool.annotations, null, 2)}</pre>
            </div>
          {/if}
          {#if !tool.inputSchema && !tool.annotations}
            <div class="mt-2 text-xs text-(--fg3) italic">No schema available</div>
          {/if}
        {/if}
      </div>
    {/each}
    {#if filteredTools.length === 0}
      <div class="text-sm text-(--fg3) text-center py-6">No tools found</div>
    {/if}
  {/if}
</div>

<style>
  .dbody {
    height: 100%;
    overflow-y: auto;
    padding: 16px 20px;
  }

  /* Filter input */
  .filter-input {
    width: 100%;
    padding: 6px 10px;
    font-size: 13px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--fg1);
    margin-bottom: 12px;
    font-family: inherit;
    outline: none;
    box-sizing: border-box;
    transition: border-color 150ms var(--ease), box-shadow 150ms var(--ease);
  }
  .filter-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-tint);
  }

  /* Tool row */
  .tool-row {
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 8px;
    background: var(--surface);
    cursor: pointer;
    overflow: hidden;
    transition: background-color 150ms var(--ease);
  }
  .tool-row:hover {
    background: var(--surface-hover);
  }
  .tool-row:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .tool-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .tool-name {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 500;
    color: var(--fg1);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tool-desc {
    font-size: 12px;
    color: var(--fg3);
    margin-top: 4px;
    line-height: 1.4;
  }

  /* Hint pills */
  .hint-pill {
    font-size: 10px;
    font-weight: 500;
    padding: 1px 7px;
    border-radius: 999px;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .hint-read {
    background: var(--hint-read-bg);
    color: var(--hint-read-fg);
  }
  .hint-dest {
    background: var(--hint-dest-bg);
    color: var(--hint-dest-fg);
  }

  /* Toggle (shared base + compact tool variant) */
  .tgl {
    position: relative;
    width: 36px;
    height: 20px;
    border-radius: 999px;
    background: var(--healthy);
    border: 0;
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
    transition: background-color 150ms var(--ease);
  }
  .tgl.tgl-off {
    background: var(--toggle-off);
  }
  .tgl > span {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 999px;
    background: #fff;
    box-shadow: 0 1px 2px var(--scrim);
    transition: transform 150ms var(--ease);
  }
  .tgl:not(.tgl-off) > span {
    transform: translateX(16px);
  }
  .tgl:disabled {
    cursor: not-allowed;
  }
  /* Compact tool-row toggle (28x14, 10x10 knob, 14px travel) */
  .tool-tgl {
    width: 28px;
    height: 14px;
  }
  .tool-tgl > span {
    width: 10px;
    height: 10px;
    top: 2px;
    left: 2px;
  }
  .tool-tgl:not(.tgl-off) > span {
    transform: translateX(14px);
  }
</style>

