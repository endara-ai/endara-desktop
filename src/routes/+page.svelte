<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import DetailPanel from '$lib/components/DetailPanel.svelte';
  import MiniPlayer from '$lib/components/MiniPlayer.svelte';
  import Settings from '$lib/components/Settings.svelte';
  import RelayLogs from '$lib/components/RelayLogs.svelte';
  import UnifiedCatalog from '$lib/components/UnifiedCatalog.svelte';
  import Onboarding from '$lib/components/Onboarding.svelte';
  import RelayError from '$lib/components/RelayError.svelte';
  import { endpoints, activeTopLevelTab, miniPlayerMode, relayConnected, relayLastError, showOnboarding, showRelayError, relayPort, relaySidecarStatus, relaySidecarError, initialLoadComplete } from '$lib/stores';
  import { getEndpoints } from '$lib/api';
  import { initRelayLogListener } from '$lib/logListener';
  import { invoke } from '@tauri-apps/api/core';
  import { get } from 'svelte/store';

  const dotColor = $derived(
    ($relaySidecarStatus === 'running' && $relayConnected) ? 'bg-green-500'
    : ($relaySidecarStatus === 'failed' && $relayConnected) ? 'bg-yellow-500'
    : ($relaySidecarStatus === 'failed' && !$relayConnected) ? 'bg-red-500'
    : ($relaySidecarStatus === 'starting' || $relaySidecarStatus === 'unknown') ? 'bg-gray-400'
    : ($relaySidecarStatus === 'stopped') ? 'bg-red-500'
    : 'bg-gray-400'
  );
  const dotPulse = $derived($relaySidecarStatus === 'starting' || $relaySidecarStatus === 'unknown');
  const dotTitle = $derived(
    ($relaySidecarStatus === 'running' && $relayConnected) ? 'Relay running'
    : ($relaySidecarStatus === 'failed' && $relayConnected) ? `Warning: Port in use by another process. ${$relaySidecarError ?? ''}`
    : ($relaySidecarStatus === 'failed') ? `Relay failed: ${$relaySidecarError ?? 'unknown error'}`
    : ($relaySidecarStatus === 'starting') ? 'Relay starting...'
    : ($relaySidecarStatus === 'stopped') ? 'Relay stopped'
    : 'Relay status unknown'
  );

  let pollInterval: ReturnType<typeof setInterval> | undefined;
  let sidebar: Sidebar | undefined = $state();

  const topLevelTabs = [
    { id: 'servers' as const, label: 'MCP Servers' },
    { id: 'unified-catalog' as const, label: 'Unified Catalog' },
    { id: 'relay-logs' as const, label: 'Relay Logs' },
    { id: 'settings' as const, label: 'Settings' },
  ];

  async function pollEndpoints() {
    const currentStatus = get(relaySidecarStatus);
    // If sidecar failed (e.g., port conflict), don't poll — we're not managing what's on that port
    if (currentStatus === 'failed') {
      relayConnected.set(false);
      endpoints.set([]);
      return;
    }
    try {
      const data = await getEndpoints();
      endpoints.set(data);
      relayConnected.set(true);
      // If sidecar status is still starting/unknown but API responds, infer running
      if (currentStatus === 'starting' || currentStatus === 'unknown') {
        relaySidecarStatus.set('running');
      }
    } catch {
      relayConnected.set(false);
      endpoints.set([]);
    }
  }

  onMount(() => {
    // Sync the configured relay port to the Rust backend
    invoke('set_relay_port', { port: get(relayPort) }).catch(() => {});
    initRelayLogListener();
    // Small delay to let the Rust sidecar startup task complete its port check
    // before we consider initial load complete
    setTimeout(() => {
      pollEndpoints().then(() => initialLoadComplete.set(true));
    }, 1000);
    pollInterval = setInterval(pollEndpoints, 2000);
  });

  onDestroy(() => {
    if (pollInterval) clearInterval(pollInterval);
  });

  function handleGlobalKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      activeTopLevelTab.set('settings');
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      if ($activeTopLevelTab === 'servers') {
        sidebar?.focusSearch();
      }
    }
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

{#if $miniPlayerMode}
  <MiniPlayer />
{:else}
  <div class="flex flex-col h-screen w-screen overflow-hidden">
    <!-- Top-level tab bar -->
    <div class="flex items-center border-b border-(--color-border) bg-(--color-surface-alt) px-2 pt-1 shrink-0 relative" data-tauri-drag-region>
      <div class="flex">
        {#each topLevelTabs as tab}
          <button
            class="px-4 py-2 text-sm font-medium transition-colors rounded-t-lg -mb-px
              {$activeTopLevelTab === tab.id
                ? 'border-b-2 border-(--color-accent) text-(--color-accent) bg-(--color-surface)'
                : 'text-(--color-text-secondary) hover:text-(--color-text) hover:bg-(--color-surface-hover)'}"
            onclick={() => activeTopLevelTab.set(tab.id)}
          >
            {tab.label}
          </button>
        {/each}
      </div>

      <!-- Relay status dot -->
      <button
        class="ml-auto flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-(--color-surface-hover) transition-colors"
        title={dotTitle}
        onclick={() => activeTopLevelTab.set('settings')}
      >
        <span class="text-xs text-(--color-text-secondary)">Relay</span>
        <span
          class="w-2.5 h-2.5 rounded-full {dotColor}"
          class:animate-pulse={dotPulse}
        ></span>
      </button>

    </div>

    <!-- Tab content -->
    <div class="flex-1 overflow-hidden">
      <div class="h-full" style:display={$activeTopLevelTab === 'servers' ? (($showOnboarding || $showRelayError) ? 'block' : 'flex') : 'none'}>
        {#if $showRelayError}
          <RelayError />
        {:else if $showOnboarding}
          <Onboarding />
        {:else}
          <Sidebar bind:this={sidebar} />
          <DetailPanel />
        {/if}
      </div>
      <div class="h-full" style:display={$activeTopLevelTab === 'unified-catalog' ? 'block' : 'none'}>
        <UnifiedCatalog />
      </div>
      <div class="h-full" style:display={$activeTopLevelTab === 'relay-logs' ? 'block' : 'none'}>
        <RelayLogs />
      </div>
      <div class="h-full" style:display={$activeTopLevelTab === 'settings' ? 'block' : 'none'}>
        <Settings />
      </div>
    </div>
  </div>
{/if}
