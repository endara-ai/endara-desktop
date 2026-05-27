<script lang="ts">
  import { theme, jsExecutionMode, toonOutput, relayPort, relayConnected, relaySidecarStatus, relaySidecarError, updateStatus, updateVersion, updateError, updateChannel, lastCheckedChannel } from '$lib/stores';
  import { autoStartEnabled, fetchAutoStart, toggleAutoStart } from '$lib/stores/autostart';
  import {
    AUTO_DISMISS_MS_MAX,
    AUTO_DISMISS_MS_MIN,
    MAX_VISIBLE_MAX,
    MAX_VISIBLE_MIN,
    fetchOverlaySettings,
    overlaySettings,
    subscribeOverlaySettingsChanges,
    updateOverlaySettings,
    type OverlayPosition,
  } from '$lib/overlay/overlaySettingsStore';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import type { Theme, RelayStatus } from '$lib/types';
  import { invoke } from '@tauri-apps/api/core';
  import { getStatus } from '$lib/api';
  import { canRetryRelay, getSettingsStatusLabel, restartRelay } from '$lib/relaySidecarUi';
  import { fetchJsExecutionMode, toggleJsExecutionMode } from '$lib/jsExecutionModeUi';
  import { fetchToonOutput, toggleToonOutput } from '$lib/toonOutputUi';
  import { checkAndAutoDownload, restartApp, getUpdateChannel, setUpdateChannel } from '$lib/updater';
  import { onMount, onDestroy } from 'svelte';
  import { toast } from 'svelte-sonner';

  let portInput: number = $state($relayPort);
  let portSaved = $state(false);
  let portError = $state<string | null>(null);
  let configFilePath = $state('~/.endara/config.toml');

  async function savePort() {
    const port = Math.floor(portInput);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      portError = 'Port must be an integer between 1 and 65535';
      return;
    }
    portError = null;
    try {
      await invoke('set_relay_port', { port });
      relayPort.set(port);
      portSaved = true;
      setTimeout(() => { portSaved = false; }, 2000);
    } catch (e) {
      portError = e instanceof Error ? e.message : String(e);
    }
  }

  const connectionItems = $derived([
    { label: 'MCP Endpoint', value: `http://localhost:${$relayPort}/mcp` },
    { label: 'SSE Endpoint', value: `http://localhost:${$relayPort}/mcp/sse` },
    { label: 'Config File', value: configFilePath },
  ]);

  let copiedIndex: number | null = $state(null);

  async function copyToClipboard(value: string, index: number) {
    await navigator.clipboard.writeText(value);
    copiedIndex = index;
    setTimeout(() => { copiedIndex = null; }, 1500);
  }

  interface BuildInfo {
    version: string;
    desktop_commit: string;
    build_date: string;
  }

  let buildInfo: BuildInfo | null = $state(null);
  let relayStatus: RelayStatus | null = $state(null);
  let statusPollInterval: ReturnType<typeof setInterval> | undefined;
  let retryingRelay = $state(false);
  let selectedChannel: 'stable' | 'beta' = $state('stable');
  let channelChanging = $state(false);

  // Keep the local toggle state in sync with the `updateChannel` store so any
  // backend-sourced re-sync (e.g. from `checkAndAutoDownload` or the
  // `update://checked` event) is reflected in the UI without manual wiring.
  $effect(() => {
    if ($updateChannel === 'stable' || $updateChannel === 'beta') {
      selectedChannel = $updateChannel;
    }
  });

  function setTheme(t: Theme) {
    theme.set(t);
  }

  async function fetchUpdateChannel() {
    try {
      const channel = await getUpdateChannel();
      if (channel === 'stable' || channel === 'beta') {
        updateChannel.set(channel);
      }
    } catch (e) {
      console.error('Failed to get update channel:', e);
    }
  }

  async function handleChannelChange(channel: 'stable' | 'beta') {
    if (channelChanging || channel === selectedChannel) return;
    const previousChannel = selectedChannel;
    channelChanging = true;
    // Optimistically reflect the change so the toggle feels responsive; we
    // revert on failure below.
    selectedChannel = channel;
    updateChannel.set(channel);
    try {
      await setUpdateChannel(channel);
      // Show info toast when switching from beta to stable
      if (previousChannel === 'beta' && channel === 'stable') {
        toast.info("You're now on the stable channel. You'll stay on your current version until a stable release newer than your current version is available.");
      }
      // Immediately check for updates on the new channel (auto-downloads if available)
      await checkAndAutoDownload();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('Failed to set update channel:', e);
      toast.error(`Failed to switch update channel: ${message}`);
      // Revert the optimistic UI change so the toggle reflects persisted truth.
      selectedChannel = previousChannel;
      updateChannel.set(previousChannel);
    } finally {
      channelChanging = false;
    }
  }

  async function fetchRelayStatus() {
    try {
      relayStatus = await getStatus();
    } catch {
      relayStatus = null;
    }
  }

  function formatUptime(seconds: number): string {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  let overlaySettingsUnlisten: UnlistenFn | null = null;

  onMount(async () => {
    try {
      buildInfo = await invoke<BuildInfo>('get_build_info');
    } catch (e) {
      console.error('Failed to get build info:', e);
    }
    fetchRelayStatus();
    fetchJsExecutionMode();
    fetchToonOutput();
    fetchAutoStart();
    fetchOverlaySettings();
    subscribeOverlaySettingsChanges()
      .then((un) => { overlaySettingsUnlisten = un; })
      .catch((e) => console.error('[overlay] subscribe failed:', e));
    fetchUpdateChannel();
    invoke('get_config_path_display').then((p: unknown) => {
      if (typeof p === 'string') configFilePath = p;
    }).catch(() => {});
    statusPollInterval = setInterval(fetchRelayStatus, 5000);
  });

  onDestroy(() => {
    if (statusPollInterval) clearInterval(statusPollInterval);
    if (overlaySettingsUnlisten) {
      overlaySettingsUnlisten();
      overlaySettingsUnlisten = null;
    }
  });

  const OVERLAY_POSITIONS: ReadonlyArray<{ value: OverlayPosition; label: string }> = [
    { value: 'top-left', label: 'Top-left' },
    { value: 'top-right', label: 'Top-right' },
    { value: 'bottom-left', label: 'Bottom-left' },
    { value: 'bottom-right', label: 'Bottom-right' },
  ];

  const isGreen = $derived($relaySidecarStatus === 'running' && $relayConnected);
  const isAmber = $derived($relaySidecarStatus === 'failed' && $relayConnected);
  const isRed = $derived(($relaySidecarStatus === 'failed' || $relaySidecarStatus === 'stopped') && !$relayConnected);
  const isStarting = $derived($relaySidecarStatus === 'starting' || $relaySidecarStatus === 'unknown');
  const isRestarting = $derived($relaySidecarStatus === 'restarting');
  const showRetryRelayButton = $derived(canRetryRelay($relaySidecarStatus));
  const statusDotColor = $derived(isGreen ? 'bg-green-500'
    : isAmber || isRestarting ? 'bg-yellow-500'
    : isRed ? 'bg-red-500'
    : 'bg-gray-400');
  const statusBadgeClass = $derived(isGreen ? 'bg-green-500/10 text-green-600 dark:text-green-400'
    : isAmber || isRestarting ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'
    : isRed ? 'bg-red-500/10 text-red-600 dark:text-red-400'
    : 'bg-gray-500/10 text-gray-600 dark:text-gray-400');
  const statusLabel = $derived(getSettingsStatusLabel($relaySidecarStatus, $relayConnected));

  async function handleRetryRelay() {
    if (retryingRelay) return;

    retryingRelay = true;

    try {
      await restartRelay(invoke);
    } catch (error) {
      console.error('Failed to restart relay:', error);
      relaySidecarError.set(error instanceof Error ? error.message : String(error));
    } finally {
      retryingRelay = false;
    }
  }
</script>

<div class="h-full overflow-y-auto p-6">
  <div class="max-w-lg mx-auto space-y-6">
    <h2 class="text-lg font-semibold">Settings</h2>

    <!-- Relay Status -->
    <div class="rounded-lg border border-(--border) p-4">
      <div class="flex items-center gap-2 mb-3">
        <span
          class="w-2.5 h-2.5 rounded-full {statusDotColor}"
          class:animate-pulse={isStarting || isRestarting}
        ></span>
        <span class="text-sm font-medium">Relay Status</span>
        <span class="text-xs px-1.5 py-0.5 rounded-full {statusBadgeClass}">
          {statusLabel}
        </span>
      </div>

      {#if isGreen && relayStatus}
        <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <span class="text-(--fg2)">Uptime</span>
          <span>{formatUptime(relayStatus.uptime_seconds)}</span>
          <span class="text-(--fg2)">Endpoints</span>
          <span>{relayStatus.endpoint_count} ({relayStatus.healthy_count} healthy)</span>
        </div>
      {/if}

      {#if isAmber}
        <div class="mt-2 p-2 rounded bg-yellow-500/10 border border-yellow-500/20">
          <p class="text-xs text-yellow-600 dark:text-yellow-400 font-medium">Warning: Port in use by another process. Your relay failed to start.</p>
          {#if $relaySidecarError}
            <p class="text-xs text-yellow-600 dark:text-yellow-400 font-mono break-all mt-1">{$relaySidecarError}</p>
          {/if}
        </div>
      {/if}

      {#if isRed}
        <p class="text-xs text-(--fg2) mt-1">
          {$relaySidecarStatus === 'stopped'
            ? 'Relay is stopped. Click Retry to start it again.'
            : `Relay failed to start on port ${$relayPort}. Check Logs for details.`}
        </p>
        {#if $relaySidecarError}
          <div class="mt-2 p-2 rounded bg-red-500/10 border border-red-500/20">
            <p class="text-xs text-red-600 dark:text-red-400 font-mono break-all">{$relaySidecarError}</p>
          </div>
        {/if}
      {/if}

      {#if isStarting}
        <p class="text-xs text-(--fg2) mt-1">
          Relay starting...
        </p>
      {/if}

      {#if isRestarting}
        <div class="mt-2 p-2 rounded bg-yellow-500/10 border border-yellow-500/20">
          <p class="text-xs text-yellow-600 dark:text-yellow-400 font-medium">Relay is restarting…</p>
          {#if $relaySidecarError}
            <p class="text-xs text-yellow-600 dark:text-yellow-400 font-mono break-all mt-1">{$relaySidecarError}</p>
          {/if}
        </div>
      {/if}

      {#if showRetryRelayButton}
        <div class="mt-3">
          <button
            class="px-3 py-1.5 text-xs rounded-lg bg-(--accent) text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            onclick={handleRetryRelay}
            disabled={retryingRelay}
          >
            {retryingRelay ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      {/if}
    </div>

    <fieldset class="border-none p-0">
      <legend class="block text-sm font-medium mb-1.5">Theme</legend>
      <div class="flex gap-2">
        {#each ['light', 'dark', 'system'] as t}
          <button
            class="px-3 py-1.5 text-sm rounded-lg border transition-colors
              {$theme === t ? 'border-(--accent) bg-(--accent)/10 text-(--accent)' : 'border-(--border) hover:bg-(--surface-hover)'}"
            onclick={() => setTheme(t as Theme)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        {/each}
      </div>
    </fieldset>

    <div class="flex items-start justify-between gap-4">
      <div>
        <div class="text-sm font-medium">JS Execution Mode</div>
        <div class="text-xs text-(--fg2) mt-0.5">When enabled, only three meta-tools are exposed to AI clients: list_tools, search_tools, and execute_tools. The AI writes JavaScript to discover and call tools dynamically, reducing context window usage.</div>
        <div class="text-xs text-(--fg2)/70 mt-1">When disabled, all tools from all endpoints are listed individually in the MCP catalog.</div>
      </div>
      <button
        class="shrink-0 relative w-10 h-5 rounded-full transition-colors {$jsExecutionMode ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}"
        onclick={() => toggleJsExecutionMode()}
        role="switch"
        aria-checked={$jsExecutionMode}
        aria-label="Toggle JS execution mode"
      >
        <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform {$jsExecutionMode ? 'translate-x-5' : ''}"></span>
      </button>
    </div>

    <div class="flex items-start justify-between gap-4">
      <div>
        <div class="text-sm font-medium">TOON Output Format</div>
        <div class="text-xs text-(--fg2) mt-0.5">Tool responses are returned in TOON format (Token-Oriented Object Notation), a compact alternative to JSON that reduces token usage by 40–60% on structured data. AI clients parse it natively.</div>
        <div class="text-xs text-(--fg2)/70 mt-1">Disable if a connected AI client has trouble parsing TOON output.</div>
      </div>
      <button
        class="shrink-0 relative w-10 h-5 rounded-full transition-colors {$toonOutput ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}"
        onclick={() => toggleToonOutput()}
        role="switch"
        aria-checked={$toonOutput}
        aria-label="Toggle TOON output format"
      >
        <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform {$toonOutput ? 'translate-x-5' : ''}"></span>
      </button>
    </div>

    <div class="flex items-start justify-between gap-4">
      <div>
        <div class="text-sm font-medium">Start on Login</div>
        <div class="text-xs text-(--fg2) mt-0.5">Automatically start Endara Desktop when you log in to your computer.</div>
      </div>
      <button
        class="shrink-0 relative w-10 h-5 rounded-full transition-colors {$autoStartEnabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}"
        onclick={() => toggleAutoStart()}
        role="switch"
        aria-checked={$autoStartEnabled}
        aria-label="Toggle start on login"
      >
        <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform {$autoStartEnabled ? 'translate-x-5' : ''}"></span>
      </button>
    </div>

    <div class="pt-4 mt-4 border-t border-(--border)">
      <div class="text-xs font-medium text-(--fg2) uppercase tracking-wide mb-3">Activity Overlay</div>

      <div class="flex items-start justify-between gap-4">
        <div>
          <div class="text-sm font-medium">Show MCP activity overlay</div>
          <div class="text-xs text-(--fg2) mt-0.5">Floating, click-through window that surfaces in-flight and recently-settled tool calls in real time.</div>
        </div>
        <button
          class="shrink-0 relative w-10 h-5 rounded-full transition-colors {$overlaySettings.enabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}"
          onclick={() => updateOverlaySettings({ enabled: !$overlaySettings.enabled })}
          role="switch"
          aria-checked={$overlaySettings.enabled}
          aria-label="Toggle MCP activity overlay"
        >
          <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform {$overlaySettings.enabled ? 'translate-x-5' : ''}"></span>
        </button>
      </div>

      <fieldset class="mt-4" disabled={!$overlaySettings.enabled} class:opacity-50={!$overlaySettings.enabled}>
        <legend class="text-xs font-medium text-(--fg2) mb-2">Corner</legend>
        <div class="grid grid-cols-2 gap-2">
          {#each OVERLAY_POSITIONS as p (p.value)}
            <button
              type="button"
              class="px-3 py-1.5 text-sm rounded-lg border transition-colors text-left
                {$overlaySettings.position === p.value ? 'border-(--accent) bg-(--accent)/10 text-(--accent)' : 'border-(--border) hover:bg-(--surface-hover)'}"
              onclick={() => updateOverlaySettings({ position: p.value })}
              aria-pressed={$overlaySettings.position === p.value}
            >
              {p.label}
            </button>
          {/each}
        </div>
      </fieldset>

      <div class="mt-4" class:opacity-50={!$overlaySettings.enabled}>
        <label for="overlay-auto-dismiss" class="flex items-center justify-between text-xs font-medium text-(--fg2) mb-1">
          <span>Auto-dismiss after</span>
          <span class="text-(--fg1) tabular-nums">{($overlaySettings.auto_dismiss_ms / 1000).toFixed(1)}s</span>
        </label>
        <input
          id="overlay-auto-dismiss"
          type="range"
          min={AUTO_DISMISS_MS_MIN}
          max={AUTO_DISMISS_MS_MAX}
          step="500"
          disabled={!$overlaySettings.enabled}
          value={$overlaySettings.auto_dismiss_ms}
          oninput={(e) => updateOverlaySettings({ auto_dismiss_ms: Number((e.currentTarget as HTMLInputElement).value) })}
          class="w-full accent-(--accent)"
        />
        <div class="text-xs text-(--fg2)/70 mt-1">Time a settled group stays on screen before fading out.</div>
      </div>

      <div class="mt-4" class:opacity-50={!$overlaySettings.enabled}>
        <label for="overlay-max-visible" class="flex items-center justify-between text-xs font-medium text-(--fg2) mb-1">
          <span>Maximum visible cards</span>
          <span class="text-(--fg1) tabular-nums">{$overlaySettings.max_visible}</span>
        </label>
        <input
          id="overlay-max-visible"
          type="range"
          min={MAX_VISIBLE_MIN}
          max={MAX_VISIBLE_MAX}
          step="1"
          disabled={!$overlaySettings.enabled}
          value={$overlaySettings.max_visible}
          oninput={(e) => updateOverlaySettings({ max_visible: Number((e.currentTarget as HTMLInputElement).value) })}
          class="w-full accent-(--accent)"
        />
        <div class="text-xs text-(--fg2)/70 mt-1">Older groups collapse into a "+N earlier" affordance.</div>
      </div>

      <div class="mt-4 flex items-start justify-between gap-4" class:opacity-50={!$overlaySettings.enabled}>
        <div>
          <div class="text-sm font-medium">Show profile name</div>
          <div class="text-xs text-(--fg2) mt-0.5">Include the active relay profile on each overlay card.</div>
        </div>
        <button
          class="shrink-0 relative w-10 h-5 rounded-full transition-colors {$overlaySettings.show_profile ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}"
          onclick={() => updateOverlaySettings({ show_profile: !$overlaySettings.show_profile })}
          disabled={!$overlaySettings.enabled}
          role="switch"
          aria-checked={$overlaySettings.show_profile}
          aria-label="Toggle profile name on overlay cards"
        >
          <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform {$overlaySettings.show_profile ? 'translate-x-5' : ''}"></span>
        </button>
      </div>
    </div>

    <div class="pt-4 mt-4 border-t border-(--border)">
      <div class="text-xs font-medium text-(--fg2) uppercase tracking-wide mb-2">Connection Info</div>
      <div class="space-y-3 mb-3">
        <div>
          <label for="relay-port" class="block text-xs font-medium mb-1 text-(--fg2)">Relay Port</label>
          <div class="flex items-center gap-2">
            <input
              id="relay-port"
              type="number"
              min="1"
              max="65535"
              bind:value={portInput}
              class="w-28 text-sm px-3 py-1.5 rounded-lg border border-(--border) bg-(--surface) text-(--fg1) focus:outline-none focus:border-(--accent)"
            />
            <button
              class="px-3 py-1.5 text-xs rounded-lg border border-(--border) hover:bg-(--surface-hover) transition-colors"
              onclick={savePort}
            >
              {portSaved ? '✓ Saved' : 'Save'}
            </button>
          </div>
          {#if portError}
            <p class="text-xs text-red-600 dark:text-red-400 mt-1">{portError}</p>
          {:else}
            <p class="text-xs text-(--fg2)/70 mt-1">Restart the app to apply port changes.</p>
          {/if}
        </div>
      </div>
      <div class="space-y-1.5">
        {#each connectionItems as item, i}
          <div class="flex items-center justify-between gap-2 group">
            <div class="min-w-0">
              <span class="text-xs text-(--fg2)">{item.label}</span>
              <span class="text-xs font-mono ml-2 select-all">{item.value}</span>
            </div>
            <button
              class="shrink-0 p-1 rounded text-(--fg2) hover:text-(--fg1) hover:bg-(--surface-hover) opacity-0 group-hover:opacity-100 transition-opacity"
              title="Copy to clipboard"
              onclick={() => copyToClipboard(item.value, i)}
            >
              {#if copiedIndex === i}
                <svg class="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" /></svg>
              {:else}
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
              {/if}
            </button>
          </div>
        {/each}
      </div>
    </div>

    {#if buildInfo}
      <div class="pt-4 mt-4 border-t border-(--border)">
        <div class="text-xs font-medium text-(--fg2) uppercase tracking-wide mb-2">About</div>
        <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <span class="text-(--fg2)">Version</span>
          <span>{buildInfo.version}</span>
          <span class="text-(--fg2)">Build Date</span>
          <span>{buildInfo.build_date}</span>
          <span class="text-(--fg2)">Desktop</span>
          <span class="font-mono text-[0.6875rem]">{buildInfo.desktop_commit}</span>
        </div>
      </div>
    {/if}

    <!-- Updates -->
    <div class="pt-4 mt-4 border-t border-(--border)">
      <div class="text-xs font-medium text-(--fg2) uppercase tracking-wide mb-2">Updates</div>

      <!-- Update Channel Selector -->
      <fieldset class="border-none p-0 mb-4">
        <legend class="block text-xs font-medium mb-1.5">Update Channel</legend>
        <div class="flex gap-2">
          <button
            class="flex-1 px-3 py-2 text-xs rounded-lg border transition-colors
              {selectedChannel === 'stable' ? 'border-(--accent) bg-(--accent)/10 text-(--accent)' : 'border-(--border) hover:bg-(--surface-hover)'}"
            onclick={() => handleChannelChange('stable')}
            disabled={channelChanging}
          >
            <div class="font-medium">Stable</div>
            <div class="text-[0.65rem] mt-0.5 opacity-70">Only receive final releases</div>
          </button>
          <button
            class="flex-1 px-3 py-2 text-xs rounded-lg border transition-colors
              {selectedChannel === 'beta' ? 'border-(--accent) bg-(--accent)/10 text-(--accent)' : 'border-(--border) hover:bg-(--surface-hover)'}"
            onclick={() => handleChannelChange('beta')}
            disabled={channelChanging}
          >
            <div class="font-medium">Beta</div>
            <div class="text-[0.65rem] mt-0.5 opacity-70">Receive pre-release (RC) builds</div>
          </button>
        </div>
      </fieldset>

      {#if $updateStatus === 'idle'}
        <button
          class="px-3 py-1.5 text-xs rounded-lg border border-(--border) hover:bg-(--surface-hover) transition-colors"
          onclick={() => checkAndAutoDownload()}
        >
          Check for Updates
        </button>
      {:else if $updateStatus === 'checking'}
        <div class="flex items-center gap-2 text-xs text-(--fg2)">
          <svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          Checking for updates...
        </div>
      {:else if $updateStatus === 'available' || $updateStatus === 'downloading'}
        <div class="flex items-center gap-2 text-xs text-(--fg2)">
          <svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          {#if $updateVersion}
            Downloading version {$updateVersion}...
          {:else}
            Downloading update...
          {/if}
        </div>
      {:else if $updateStatus === 'ready'}
        <div class="space-y-2">
          <p class="text-xs">
            {#if $updateVersion}
              Version <span class="font-mono font-medium">{$updateVersion}</span> downloaded, restart to apply.
            {:else}
              Update downloaded, restart to apply.
            {/if}
          </p>
          <button
            class="px-3 py-1.5 text-xs rounded-lg bg-(--accent) text-white hover:opacity-90 transition-opacity"
            onclick={() => restartApp()}
          >
            Restart Now
          </button>
        </div>
      {:else if $updateStatus === 'up-to-date'}
        <p class="text-xs text-green-600 dark:text-green-400">You're up to date ✓</p>
      {:else if $updateStatus === 'error'}
        <div class="space-y-2">
          <p class="text-xs text-red-600 dark:text-red-400">Update check failed: {$updateError}</p>
          <button
            class="px-3 py-1.5 text-xs rounded-lg border border-(--border) hover:bg-(--surface-hover) transition-colors"
            onclick={() => checkAndAutoDownload()}
          >
            Retry
          </button>
        </div>
      {/if}

      {#if $lastCheckedChannel}
        <p class="text-[0.65rem] text-(--fg2)/70 mt-2">
          Checked {$lastCheckedChannel} channel
        </p>
      {/if}
    </div>
  </div>
</div>
