<script lang="ts">
  import { selectedEndpointData, activeTab, selectedEndpoint, endpoints } from '$lib/stores';
  import { restartEndpoint, refreshEndpoint, removeEndpoint, getEndpoints } from '$lib/api';
  import ToolsTab from './ToolsTab.svelte';
  import LogsTab from './LogsTab.svelte';
  import ConfigTab from './ConfigTab.svelte';
  import ConfirmModal from './ConfirmModal.svelte';
  import HealthDot from './HealthDot.svelte';
  import TransportBadge from './TransportBadge.svelte';

  let showRestartConfirm = $state(false);
  let showDeleteConfirm = $state(false);

  const tabs = [
    { id: 'tools' as const, label: 'Tools' },
    { id: 'logs' as const, label: 'Logs' },
    { id: 'config' as const, label: 'Config' },
  ];

  async function handleRestart() {
    const name = $selectedEndpoint;
    if (name) {
      try { await restartEndpoint(name); } catch { /* ignore */ }
    }
    showRestartConfirm = false;
  }

  async function handleRefresh() {
    const name = $selectedEndpoint;
    if (name) {
      try { await refreshEndpoint(name); } catch { /* ignore */ }
    }
  }

  async function handleDelete() {
    const name = $selectedEndpoint;
    if (name) {
      try {
        await removeEndpoint(name);
        selectedEndpoint.set(null);
        try {
          const data = await getEndpoints();
          endpoints.set(data);
        } catch { /* will be picked up by next poll */ }
      } catch { /* ignore */ }
    }
    showDeleteConfirm = false;
  }
</script>

<div class="flex-1 h-full flex flex-col bg-(--color-surface)">
  {#if $selectedEndpointData}
    {@const ep = $selectedEndpointData}
    <div class="px-5 py-3 border-b border-(--color-border) flex items-center justify-between">
      <div class="flex items-center gap-3">
        <HealthDot health={ep.health} />
        <div>
          <h2 class="text-base font-semibold">{ep.name}</h2>
          <div class="flex items-center gap-2 mt-0.5">
            <TransportBadge transport={ep.transport} />
            <span class="text-xs text-(--color-text-secondary)">{ep.tool_count} tools</span>
          </div>
        </div>
      </div>
      <div class="flex gap-2">
        <button
          class="px-2.5 py-1 text-xs rounded-lg border border-(--color-border) hover:bg-(--color-surface-hover) transition-colors"
          onclick={handleRefresh}
        >Refresh</button>
        <button
          class="px-2.5 py-1 text-xs rounded-lg border border-(--color-offline)/30 text-(--color-offline) hover:bg-(--color-offline)/10 transition-colors"
          onclick={() => showRestartConfirm = true}
        >Restart</button>
        <button
          class="px-2.5 py-1 text-xs rounded-lg border border-(--color-offline)/30 text-(--color-offline) hover:bg-(--color-offline)/10 transition-colors"
          onclick={() => showDeleteConfirm = true}
        >Delete</button>
      </div>
    </div>

    <div class="flex border-b border-(--color-border)">
      {#each tabs as tab}
        <button
          class="px-4 py-2 text-sm font-medium transition-colors border-b-2
            {$activeTab === tab.id ? 'border-(--color-accent) text-(--color-accent)' : 'border-transparent text-(--color-text-secondary) hover:text-(--color-text)'}"
          onclick={() => activeTab.set(tab.id)}
        >{tab.label}</button>
      {/each}
    </div>

    <div class="flex-1 overflow-hidden">
      {#if $activeTab === 'tools'}
        <ToolsTab />
      {:else if $activeTab === 'logs'}
        <LogsTab />
      {:else}
        <ConfigTab />
      {/if}
    </div>

    {#if showRestartConfirm}
      <ConfirmModal
        title="Restart Endpoint"
        message="Are you sure you want to restart '{ep.name}'? This will temporarily disconnect the endpoint."
        confirmLabel="Restart"
        onconfirm={handleRestart}
        oncancel={() => showRestartConfirm = false}
      />
    {/if}

    {#if showDeleteConfirm}
      <ConfirmModal
        title="Delete Endpoint"
        message="Are you sure you want to delete '{ep.name}'? This will remove it from your configuration."
        confirmLabel="Delete"
        onconfirm={handleDelete}
        oncancel={() => showDeleteConfirm = false}
      />
    {/if}
  {:else}
    <div class="flex-1 flex items-center justify-center text-(--color-text-secondary)">
      <div class="text-center">
        <div class="text-4xl mb-3">⚡</div>
        <div class="text-sm">Select an endpoint to view details</div>
      </div>
    </div>
  {/if}
</div>

