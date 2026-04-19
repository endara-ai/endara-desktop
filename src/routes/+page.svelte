<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import DetailPanel from '$lib/components/DetailPanel.svelte';
  import MiniPlayer from '$lib/components/MiniPlayer.svelte';
  import Settings from '$lib/components/Settings.svelte';
  import RelayLogs from '$lib/components/RelayLogs.svelte';
  import UnifiedCatalog from '$lib/components/UnifiedCatalog.svelte';
  import Onboarding from '$lib/components/Onboarding.svelte';
  import { endpoints, activeTopLevelTab, miniPlayerMode, relayConnected, showOnboarding, relayPort, relaySidecarStatus, relaySidecarError, initialLoadComplete, oauthStatuses } from '$lib/stores';
  import { getEndpoints, getOAuthStatus } from '$lib/api';
  import { initRelayLogListener } from '$lib/logListener';
  import { getActiveTopLevelTab, getVisibleTopLevelTabs, shouldShowRelayStartupFailure, shouldSkipEndpointPolling } from '$lib/relaySidecarUi';
  import { invoke } from '@tauri-apps/api/core';
  import { get } from 'svelte/store';

  const dotColor = $derived(
    ($relaySidecarStatus === 'running' && $relayConnected) ? 'bg-(--healthy)'
    : ($relaySidecarStatus === 'failed' && $relayConnected) ? 'bg-(--degraded)'
    : ($relaySidecarStatus === 'failed' && !$relayConnected) ? 'bg-(--offline)'
    : ($relaySidecarStatus === 'starting' || $relaySidecarStatus === 'unknown') ? 'bg-(--fg3)'
    : ($relaySidecarStatus === 'stopped') ? 'bg-(--offline)'
    : 'bg-(--fg3)'
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
  const relayFailureMessage = $derived($relaySidecarError ?? 'Relay failed to start. Check Logs for more details.');

  let pollInterval: ReturnType<typeof setInterval> | undefined;
  let sidebar: Sidebar | undefined = $state();
  let retryingRelay = $state(false);
  let relayStartupFailureDismissed = $state(false);
  const showRelayStartupFailure = $derived(shouldShowRelayStartupFailure($relaySidecarStatus, $relayConnected, relayStartupFailureDismissed));

  const topLevelTabs = $derived(getVisibleTopLevelTabs($relaySidecarStatus));

  $effect(() => {
    if (!($relaySidecarStatus === 'failed' && !$relayConnected)) {
      relayStartupFailureDismissed = false;
    }
  });

  $effect(() => {
    if (getActiveTopLevelTab($activeTopLevelTab, $relaySidecarStatus) !== $activeTopLevelTab) {
      activeTopLevelTab.set('settings');
    }
  });

  async function pollEndpoints() {
    const currentStatus = get(relaySidecarStatus);
    // If sidecar failed (e.g., port conflict), don't poll — we're not managing what's on that port
    if (shouldSkipEndpointPolling(currentStatus)) {
      relayConnected.set(false);
      endpoints.set([]);
      return;
    }
    try {
      const data = await getEndpoints();
      endpoints.set(data);
      relayConnected.set(true);
      // Poll OAuth statuses for OAuth endpoints
      const oauthEndpoints = data.filter(ep => ep.transport === 'oauth');
      if (oauthEndpoints.length > 0) {
        const statusMap = new Map(get(oauthStatuses));
        await Promise.allSettled(
          oauthEndpoints.map(async (ep) => {
            try {
              const s = await getOAuthStatus(ep.name);
              statusMap.set(ep.name, s);
            } catch { /* ignore */ }
          })
        );
        oauthStatuses.set(statusMap);
      }
      // If sidecar status is still starting/unknown but API responds, infer running
      const inferredStatus = get(relaySidecarStatus);
      if (inferredStatus === 'starting' || inferredStatus === 'unknown') {
        relaySidecarStatus.set('running');
      }
    } catch {
      relayConnected.set(false);
      endpoints.set([]);
    }
  }

  onMount(() => {
    // Sync the relay port FROM the Rust backend (config.toml is the source of truth)
    invoke('get_relay_port').then((port: unknown) => {
      if (typeof port === 'number' && port > 0) {
        relayPort.set(port as number);
      }
    }).catch(() => {});
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
  <div class="flex h-screen w-screen items-center justify-center bg-(--surface-alt) p-6">
    <div class="w-full max-w-2xl rounded-2xl border border-red-500/20 bg-(--surface) p-8 shadow-sm">
      <div class="mb-6 inline-flex items-center rounded-full bg-red-500/10 px-3 py-1 text-xs font-medium text-red-600 dark:text-red-400">
        Relay startup failed
      </div>

      <div class="space-y-3">
        <h1 class="text-2xl font-semibold text-(--fg1)">Endara Desktop couldn&apos;t start the relay</h1>
        <p class="text-sm text-(--fg2)">
          The app can&apos;t connect to the relay on port {$relayPort}. Review the startup error below, check the logs, or update your settings and try again.
        </p>
      </div>

      <div class="mt-6 rounded-xl border border-red-500/20 bg-red-500/10 p-4">
        <div class="text-xs font-medium uppercase tracking-wide text-red-600 dark:text-red-400">Error details</div>
        <p class="mt-2 whitespace-pre-wrap break-words font-mono text-sm text-red-600 dark:text-red-400">{relayFailureMessage}</p>
      </div>

      <div class="mt-8 flex flex-wrap gap-3">
        <button
          class="rounded-lg bg-(--accent) px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          onclick={handleRetryRelay}
          disabled={retryingRelay}
        >
          {retryingRelay ? 'Retrying…' : 'Retry'}
        </button>
        <button
          class="rounded-lg border border-(--border) px-4 py-2 text-sm font-medium text-(--fg1) transition-colors hover:bg-(--surface-hover)"
          onclick={openRelayLogs}
        >
          View Logs
        </button>
        <button
          class="rounded-lg border border-(--border) px-4 py-2 text-sm font-medium text-(--fg1) transition-colors hover:bg-(--surface-hover)"
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
    <div class="flex items-center border-b border-(--border) bg-(--chrome-bg) px-2 pt-1 shrink-0 relative" data-tauri-drag-region>
      <div class="flex">
        {#each topLevelTabs as tab}
          <button
            class="px-[14px] py-1.5 text-[13px] font-medium transition-colors rounded-t-lg -mb-px border-b-2
              {$activeTopLevelTab === tab.id
                ? 'border-(--accent) text-(--accent) bg-(--win-bg)'
                : 'border-transparent text-(--fg3) hover:text-(--fg1) hover:bg-(--hover-bg)'}"
            onclick={() => activeTopLevelTab.set(tab.id)}
          >
            {tab.label}
          </button>
        {/each}
      </div>

      <!-- Relay status pill -->
      <button
        class="ml-auto flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-(--fg3) hover:bg-(--hover-bg) transition-colors"
        title={dotTitle}
        onclick={() => activeTopLevelTab.set('settings')}
      >
        <span>Relay</span>
        <span
          class="w-2 h-2 rounded-full {dotColor}"
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
