<script lang="ts">
  import { selectedEndpointData, activeTab, selectedEndpoint, endpoints } from '$lib/stores';
  import { restartEndpoint, refreshEndpoint, removeEndpoint, getEndpoints, disableEndpoint, enableEndpoint } from '$lib/api';
  import { toast } from 'svelte-sonner';
  import ToolsTab from './ToolsTab.svelte';
  import LogsTab from './LogsTab.svelte';
  import ConfigTab from './ConfigTab.svelte';
  import ConfirmModal from './ConfirmModal.svelte';
  import HealthDot from './HealthDot.svelte';
  import EndpointIcon from './EndpointIcon.svelte';
  import TransportBadge from './TransportBadge.svelte';
  import AuthTab from './AuthTab.svelte';

  let showRestartConfirm = $state(false);
  let showDeleteConfirm = $state(false);
  let toggling = $state(false);

  const baseTabs = [
    { id: 'tools' as const, label: 'Tools' },
    { id: 'logs' as const, label: 'Logs' },
    { id: 'config' as const, label: 'Config' },
  ];

  let tabs = $derived(
    $selectedEndpointData?.transport === 'oauth'
      ? [...baseTabs, { id: 'auth' as const, label: 'Auth' }]
      : baseTabs
  );

  async function handleRestart() {
    const name = $selectedEndpoint;
    if (name) {
      try {
        await restartEndpoint(name);
        toast.success(`Server "${name}" restarted`);
      } catch {
        toast.error(`Failed to restart "${name}"`);
      }
    }
    showRestartConfirm = false;
  }

  async function handleRefresh() {
    const name = $selectedEndpoint;
    if (name) {
      try {
        await refreshEndpoint(name);
        toast.success(`Tools refreshed for "${name}"`);
      } catch {
        toast.error(`Failed to refresh "${name}"`);
      }
    }
  }

  async function handleToggle() {
    const ep = $selectedEndpointData;
    if (!ep || toggling) return;
    toggling = true;
    const action = ep.disabled ? 'enable' : 'disable';
    try {
      if (ep.disabled) {
        await enableEndpoint(ep.name);
      } else {
        await disableEndpoint(ep.name);
      }
      try {
        const data = await getEndpoints();
        endpoints.set(data);
      } catch { /* will be picked up by next poll */ }
      toast.success(`Server "${ep.name}" ${ep.disabled ? 'enabled' : 'disabled'}`);
    } catch {
      toast.error(`Failed to ${action} "${ep.name}"`);
    }
    toggling = false;
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
        toast.success(`Server "${name}" deleted`);
      } catch {
        toast.error(`Failed to delete "${name}"`);
      }
    }
    showDeleteConfirm = false;
  }
</script>

<div class="flex-1 h-full flex flex-col bg-(--color-surface) min-w-0">
  {#if $selectedEndpointData}
    {@const ep = $selectedEndpointData}
    <div class="px-5 py-3 border-b border-(--color-border) flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="relative flex-shrink-0" style="width: 24px; height: 24px;">
          <EndpointIcon endpoint={ep} size={24} />
          <span class="absolute -bottom-0.5 -right-0.5">
            <HealthDot health={ep.health} />
          </span>
        </div>
        <div>
          <h2 class="text-base font-semibold">{ep.name}</h2>
          <div class="flex items-center gap-2 mt-0.5">
            <TransportBadge transport={ep.transport} />
            <span class="text-xs text-(--color-text-secondary)">{ep.tool_count} tools</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <div class="flex items-center gap-2">
          <button
            class="relative w-10 h-5 rounded-full transition-colors {ep.disabled ? 'bg-gray-300 dark:bg-gray-600' : 'bg-green-500'} {toggling ? 'opacity-50' : ''}"
            onclick={handleToggle}
            disabled={toggling}
            title={ep.disabled ? 'Enable server' : 'Disable server'}
          >
            <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform {ep.disabled ? '' : 'translate-x-5'}"></span>
          </button>
        </div>
        <button
          class="px-2.5 py-1 text-xs rounded-lg border border-(--color-border) hover:bg-(--color-surface-hover) transition-colors"
          onclick={handleRefresh}
        >Refresh</button>
        <button
          class="px-2.5 py-1 text-xs rounded-lg border border-(--color-offline)/30 text-(--color-offline) hover:bg-(--color-offline)/10 transition-colors"
          onclick={() => showRestartConfirm = true}
          title={ep.transport === 'stdio' ? 'Kill and restart the server process' : ep.transport === 'sse' ? 'Reconnect the SSE event stream' : ep.transport === 'http' ? 'Re-run the MCP handshake' : 'Reload tokens and reconnect'}
        >{ep.transport === 'stdio' ? 'Restart' : 'Reconnect'}</button>
        <button
          class="px-2.5 py-1 text-xs rounded-lg border border-(--color-offline)/30 text-(--color-offline) hover:bg-(--color-offline)/10 transition-colors"
          onclick={() => showDeleteConfirm = true}
        >Delete</button>
      </div>
    </div>

    {#if ep.error}
      <div class="px-5 py-3 bg-red-50 dark:bg-red-950 border-b border-red-200 dark:border-red-800">
        <div class="flex items-start gap-2">
          <span class="text-red-500 flex-shrink-0">⚠</span>
          <div>
            <div class="text-sm font-medium text-red-700 dark:text-red-300">Initialization Error</div>
            <div class="text-xs text-red-600 dark:text-red-400 mt-0.5 whitespace-pre-wrap break-all max-h-[5lh] overflow-y-auto">{ep.error}</div>
          </div>
        </div>
      </div>
    {/if}

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
      {:else if $activeTab === 'auth' && ep.transport === 'oauth'}
        <AuthTab />
      {:else}
        <ConfigTab />
      {/if}
    </div>

    {#if showRestartConfirm}
      <ConfirmModal
        title="{ep.transport === 'stdio' ? 'Restart' : 'Reconnect'} Endpoint"
        message="Are you sure you want to {ep.transport === 'stdio' ? 'restart' : 'reconnect'} '{ep.name}'? This will temporarily disconnect the endpoint."
        confirmLabel={ep.transport === 'stdio' ? 'Restart' : 'Reconnect'}
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

