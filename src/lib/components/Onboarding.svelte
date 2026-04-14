<script lang="ts">
  import { relayPort } from '$lib/stores';
  import { invoke } from '@tauri-apps/api/core';
  import { onMount } from 'svelte';
  import AddEndpointModal from './AddEndpointModal.svelte';

  const RELAY_MCP_URL = $derived(`http://localhost:${$relayPort}/mcp`);
  const RELAY_SSE_URL = $derived(`http://localhost:${$relayPort}/mcp/sse`);

  let showAddModal = $state(false);

  let copied = $state(false);
  function copyUrl(text: string) {
    navigator.clipboard.writeText(text);
    copied = true;
    setTimeout(() => copied = false, 2000);
  }

  let autostart = $state(false);

  onMount(async () => {
    try {
      autostart = await invoke<boolean>('get_autostart');
    } catch (e) {
      console.error('Failed to get autostart state:', e);
    }
  });

  async function toggleAutostart() {
    const newValue = !autostart;
    autostart = newValue;
    try {
      await invoke('set_autostart', { enabled: newValue });
    } catch (e) {
      // Revert on failure
      autostart = !newValue;
      console.error('Failed to set autostart:', e);
    }
  }
</script>

<div class="h-full overflow-y-auto p-8">
  <div class="max-w-lg mx-auto space-y-6">
    <div class="text-center space-y-2">
      <h1 class="text-2xl font-bold text-(--color-text)">Welcome to Endara</h1>
      <p class="text-sm text-(--color-text-secondary)">Endara relays MCP servers to your AI tools.</p>
    </div>

    <!-- Relay URL info -->
    <div class="rounded-lg border border-(--color-border) bg-(--color-surface-alt) p-4 space-y-2">
      <h3 class="text-sm font-semibold text-(--color-text)">Connect your AI client</h3>
      <p class="text-xs text-(--color-text-secondary)">
        Point Claude Desktop or other MCP clients to the Endara relay:
      </p>
      <div class="flex items-center gap-2">
        <code class="flex-1 text-xs font-mono bg-(--color-surface) border border-(--color-border) rounded px-2 py-1.5 text-(--color-accent)">
          {RELAY_MCP_URL}
        </code>
        <button
          class="text-xs px-2 py-1.5 rounded border border-(--color-border) hover:bg-(--color-surface-hover) transition-colors"
          onclick={() => copyUrl(RELAY_MCP_URL)}
        >
          {copied ? '✓' : 'Copy'}
        </button>
      </div>
      <p class="text-xs text-(--color-text-secondary)">
        SSE endpoint: <code class="font-mono text-(--color-accent)">{RELAY_SSE_URL}</code>
      </p>
    </div>

    <button
      class="w-full px-4 py-3 text-sm font-medium rounded-lg bg-(--color-accent) text-white hover:bg-(--color-accent-hover) transition-colors shadow-sm"
      onclick={() => showAddModal = true}
    >
      Add Your First Server
    </button>

    <!-- Autostart toggle -->
    <div class="rounded-lg border border-(--color-border) bg-(--color-surface-alt) p-4">
      <div class="flex items-start justify-between gap-4">
        <div>
          <div class="text-sm font-medium text-(--color-text)">Start on Login</div>
          <div class="text-xs text-(--color-text-secondary) mt-0.5">Automatically start Endara Desktop when you log in to your computer.</div>
        </div>
        <button
          class="shrink-0 relative w-10 h-5 rounded-full transition-colors {autostart ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}"
          onclick={() => toggleAutostart()}
          role="switch"
          aria-checked={autostart}
          aria-label="Toggle start on login"
        >
          <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform {autostart ? 'translate-x-5' : ''}"></span>
        </button>
      </div>
    </div>
  </div>
</div>

{#if showAddModal}
  <AddEndpointModal onclose={() => showAddModal = false} />
{/if}

