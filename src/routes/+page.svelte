<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import DetailPanel from '$lib/components/DetailPanel.svelte';
  import MiniPlayer from '$lib/components/MiniPlayer.svelte';
  import Settings from '$lib/components/Settings.svelte';
  import RelayLogs from '$lib/components/RelayLogs.svelte';
  import UnifiedCatalog from '$lib/components/UnifiedCatalog.svelte';
  import Onboarding from '$lib/components/Onboarding.svelte';
  import { endpoints, activeTopLevelTab, miniPlayerMode, relayConnected, relayLastError, showOnboarding, relayPort, relaySidecarStatus, relaySidecarError, initialLoadComplete } from '$lib/stores';
  import { getEndpoints } from '$lib/api';
  import { initRelayLogListener } from '$lib/logListener';
  import { getActiveTopLevelTab, getVisibleTopLevelTabs } from '$lib/relaySidecarUi';
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
  const relayStartupFailureActive = $derived($relaySidecarStatus === 'failed' && !$relayConnected);
  const relayFailureMessage = $derived($relaySidecarError ?? 'Relay failed to start. Check Relay Logs for more details.');

  let pollInterval: ReturnType<typeof setInterval> | undefined;
  let sidebar: Sidebar | undefined = $state();
  let retryingRelay = $state(false);
  let relayStartupFailureDismissed = $state(false);
  const showRelayStartupFailure = $derived(relayStartupFailureActive && !relayStartupFailureDismissed);

  const topLevelTabs = $derived(getVisibleTopLevelTabs($relaySidecarStatus));

  $effect(() => {
    if (!relayStartupFailureActive) {
      relayStartupFailureDismissed = false;
    }
  });

  $effect(() => {
    if (getActiveTopLevelTab($activeTopLevelTab, $relaySidecarStatus) !== $activeTopLevelTab) {
      activeTopLevelTab.set('settings');
    }
  });

  async function pollEndpoints() {
    try {
      const data = await getEndpoints();
      endpoints.set(data);
      relayConnected.set(true);
      // If sidecar status is still starting/unknown but API responds, infer running
      const currentStatus = get(relaySidecarStatus);
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
    pollEndpoints().then(() => initialLoadComplete.set(true));
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

  function openRelayLogs() {
    relayStartupFailureDismissed = true;
    activeTopLevelTab.set('relay-logs');
  }

  function openSettings() {
    relayStartupFailureDismissed = true;
    activeTopLevelTab.set('settings');
  }

  async function handleRetryRelay() {
    if (retryingRelay) return;

    relayStartupFailureDismissed = false;
    retryingRelay = true;

    try {
      await invoke('restart_relay');
    } catch (error) {
      console.error('Failed to restart relay:', error);
      relaySidecarError.set(error instanceof Error ? error.message : String(error));
    } finally {
      retryingRelay = false;
    }
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

{#if showRelayStartupFailure}
  <div class="flex h-screen w-screen items-center justify-center bg-(--color-surface-alt) p-6">
    <div class="w-full max-w-2xl rounded-2xl border border-red-500/20 bg-(--color-surface) p-8 shadow-sm">
      <div class="mb-6 inline-flex items-center rounded-full bg-red-500/10 px-3 py-1 text-xs font-medium text-red-600 dark:text-red-400">
        Relay startup failed
      </div>

      <div class="space-y-3">
        <h1 class="text-2xl font-semibold text-(--color-text)">Endara Desktop couldn&apos;t start the relay</h1>
        <p class="text-sm text-(--color-text-secondary)">
          The app can&apos;t connect to the relay on port {$relayPort}. Review the startup error below, check the relay logs, or update your settings and try again.
        </p>
      </div>

      <div class="mt-6 rounded-xl border border-red-500/20 bg-red-500/10 p-4">
        <div class="text-xs font-medium uppercase tracking-wide text-red-600 dark:text-red-400">Error details</div>
        <p class="mt-2 whitespace-pre-wrap break-words font-mono text-sm text-red-600 dark:text-red-400">{relayFailureMessage}</p>
      </div>

      <div class="mt-8 flex flex-wrap gap-3">
        <button
          class="rounded-lg bg-(--color-accent) px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          onclick={handleRetryRelay}
          disabled={retryingRelay}
        >
          {retryingRelay ? 'Retrying…' : 'Retry'}
        </button>
        <button
          class="rounded-lg border border-(--color-border) px-4 py-2 text-sm font-medium text-(--color-text) transition-colors hover:bg-(--color-surface-hover)"
          onclick={openRelayLogs}
        >
          View Relay Logs
        </button>
        <button
          class="rounded-lg border border-(--color-border) px-4 py-2 text-sm font-medium text-(--color-text) transition-colors hover:bg-(--color-surface-hover)"
          onclick={openSettings}
        >
          Open Settings
        </button>
      </div>
    </div>
  </div>
{:else if $miniPlayerMode}
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
      <div class="h-full" style:display={$activeTopLevelTab === 'servers' ? ($showOnboarding ? 'block' : 'flex') : 'none'}>
        {#if $showOnboarding}
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
