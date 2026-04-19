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

<div class="flex-1 h-full flex flex-col bg-(--surface) min-w-0">
  {#if $selectedEndpointData}
    {@const ep = $selectedEndpointData}
    <div class="dhdr flex items-center justify-between">
      <div class="flex items-center gap-3 min-w-0">
        <div class="relative flex-shrink-0" style="width: 24px; height: 24px;">
          <EndpointIcon endpoint={ep} size={24} />
          <span class="absolute -bottom-0.5 -right-0.5">
            <HealthDot health={ep.health} stacked />
          </span>
        </div>
        <div class="min-w-0">
          <h2 class="dhdr-name truncate">{ep.name}</h2>
          <div class="flex items-center gap-2 mt-0.5">
            <TransportBadge transport={ep.transport} />
            <span class="text-[11px] text-(--fg3)">{ep.tool_count} tools</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-1.5 flex-shrink-0">
        <button
          class="tgl {ep.disabled ? 'tgl-off' : ''} {toggling ? 'opacity-50' : ''}"
          onclick={handleToggle}
          disabled={toggling}
          title={ep.disabled ? 'Enable server' : 'Disable server'}
          aria-label={ep.disabled ? 'Enable server' : 'Disable server'}
        ><span></span></button>
        <button class="btn-sec" onclick={handleRefresh}>Refresh</button>
        <button
          class="btn-sec btn-danger"
          onclick={() => showRestartConfirm = true}
          title={ep.transport === 'stdio' ? 'Kill and restart the server process' : ep.transport === 'sse' ? 'Reconnect the SSE event stream' : ep.transport === 'http' ? 'Re-run the MCP handshake' : 'Reload tokens and reconnect'}
        >{ep.transport === 'stdio' ? 'Restart' : 'Reconnect'}</button>
        <button class="btn-sec btn-danger" onclick={() => showDeleteConfirm = true}>Delete</button>
      </div>
    </div>

    {#if ep.error}
      <div class="px-5 py-3 border-b" style="background: color-mix(in oklab, var(--offline) 12%, transparent); border-bottom-color: color-mix(in oklab, var(--offline) 30%, transparent);">
        <div class="flex items-start gap-2">
          <span class="flex-shrink-0 text-(--offline)">⚠</span>
          <div>
            <div class="text-sm font-medium text-(--offline)">Initialization Error</div>
            <div class="text-xs text-(--offline) mt-0.5 whitespace-pre-wrap break-all max-h-[5lh] overflow-y-auto opacity-90">{ep.error}</div>
          </div>
        </div>
      </div>
    {/if}

    <div class="dtabs">
      {#each tabs as tab}
        <button
          class="dtab {$activeTab === tab.id ? 'active' : ''}"
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
    <div class="flex-1 flex items-center justify-center text-(--fg3)">
      <div class="text-center">
        <div class="text-4xl mb-3 text-(--fg3)"><svg class="inline-block w-10 h-10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2L5 11h5l-1.5 7L15 9h-5l1.5-7z"/></svg></div>
        <div class="text-sm">Select an endpoint to view details</div>
      </div>
    </div>
  {/if}
</div>

<style>
  .dhdr {
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--hd-bg);
  }
  .dhdr-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--fg1);
    line-height: 1.2;
  }

  /* Toggle pill (36x20) */
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

  /* Secondary button */
  .btn-sec {
    padding: 4px 10px;
    font-size: 11px;
    line-height: 1.4;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: transparent;
    color: var(--fg1);
    cursor: pointer;
    font-family: inherit;
    transition: background-color 150ms var(--ease), color 150ms var(--ease);
  }
  .btn-sec:hover {
    background: var(--hover-bg);
  }
  .btn-danger {
    border-color: color-mix(in oklab, var(--offline) 35%, transparent);
    color: var(--offline);
  }
  .btn-danger:hover {
    background: color-mix(in oklab, var(--offline) 8%, transparent);
  }

  /* Detail tabs */
  .dtabs {
    display: flex;
    border-bottom: 1px solid var(--border);
    background: var(--hd-bg);
  }
  .dtab {
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 500;
    color: var(--fg3);
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    cursor: pointer;
    font-family: inherit;
    margin-bottom: -1px;
    transition: color 150ms var(--ease), border-color 150ms var(--ease);
  }
  .dtab:hover {
    color: var(--fg1);
  }
  .dtab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
</style>
