<script lang="ts">
  import { relaySidecarError, activeTopLevelTab } from '$lib/stores';
  import { invoke } from '@tauri-apps/api/core';

  let retrying = $state(false);

  async function handleRetry() {
    retrying = true;
    try {
      await invoke('restart_relay');
    } catch (e) {
      console.error('Failed to restart relay:', e);
    } finally {
      retrying = false;
    }
  }

  function viewRelayLogs() {
    activeTopLevelTab.set('relay-logs');
  }
</script>

<div class="h-full overflow-y-auto p-8">
  <div class="max-w-lg mx-auto space-y-6">
    <div class="text-center space-y-2">
      <div class="text-4xl mb-4">⚠️</div>
      <h1 class="text-2xl font-bold text-(--color-text)">Relay failed to start</h1>
      <p class="text-sm text-(--color-text-secondary)">
        The Endara relay sidecar encountered an error and could not start.
      </p>
    </div>

    {#if $relaySidecarError}
      <div class="rounded-lg border border-red-500/30 bg-red-500/10 p-4 space-y-1">
        <h3 class="text-sm font-semibold text-(--color-text)">Error details</h3>
        <p class="text-xs font-mono text-red-400 whitespace-pre-wrap break-all">{$relaySidecarError}</p>
      </div>
    {/if}

    {#if $relaySidecarError?.includes('already in use')}
      <div class="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4 space-y-2">
        <h3 class="text-sm font-semibold text-(--color-text)">Port conflict</h3>
        <p class="text-xs text-(--color-text-secondary)">
          Another process is using the relay port. This is usually a stale relay from a previous session.
        </p>
        <p class="text-xs text-(--color-text-secondary)">
          Try closing any other applications that may be using this port, or change the relay port in Settings.
        </p>
      </div>
    {/if}

    {#if !$relaySidecarError?.includes('already in use')}
      <div class="rounded-lg border border-(--color-border) bg-(--color-surface-alt) p-4 space-y-2">
        <h3 class="text-sm font-semibold text-(--color-text)">Configuration</h3>
        <p class="text-xs text-(--color-text-secondary)">
          Check your relay configuration file for errors:
        </p>
        <code class="block text-xs font-mono bg-(--color-surface) border border-(--color-border) rounded px-2 py-1.5 text-(--color-accent)">
          ~/.endara/config.toml
        </code>
      </div>
    {/if}

    <div class="flex gap-3">
      <button
        class="flex-1 px-3 py-2 text-sm rounded-lg border border-(--color-border) hover:bg-(--color-surface-hover) transition-colors"
        onclick={viewRelayLogs}
      >
        View Relay Logs
      </button>
      <button
        class="flex-1 px-3 py-2 text-sm rounded-lg bg-(--color-accent) text-white hover:bg-(--color-accent-hover) transition-colors disabled:opacity-50"
        onclick={handleRetry}
        disabled={retrying}
      >
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  </div>
</div>

