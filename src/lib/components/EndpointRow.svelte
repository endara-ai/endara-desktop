<script lang="ts">
  import type { Endpoint, OAuthStatusValue } from '$lib/types';
  import { selectedEndpoint, oauthStatuses } from '$lib/stores';
  import HealthDot from './HealthDot.svelte';
  import EndpointIcon from './EndpointIcon.svelte';
  import TransportBadge from './TransportBadge.svelte';

  let { endpoint }: { endpoint: Endpoint } = $props();

  const authIcons: Record<OAuthStatusValue, string> = {
    authenticated: '🔑',
    refreshing: '🔄',
    auth_required: '🔒',
    needs_login: '🔒',
    disconnected: '⚠️',
    connection_failed: '⚠️',
  };

  let oauthStatus = $derived(
    endpoint.transport === 'oauth' ? $oauthStatuses.get(endpoint.name) : undefined
  );

  function select() {
    selectedEndpoint.set(endpoint.name);
  }
</script>

<button
  class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors
    hover:bg-(--color-surface-hover)
    {$selectedEndpoint === endpoint.name ? 'bg-(--color-surface-hover)' : ''}
    {endpoint.disabled ? 'opacity-50' : ''}"
  onclick={select}
>
  <div class="relative flex-shrink-0" style="width: 20px; height: 20px;">
    <EndpointIcon {endpoint} size={20} />
    <span class="absolute -bottom-0.5 -right-0.5">
      <HealthDot health={endpoint.error ? 'error' : endpoint.health} />
    </span>
  </div>
  <div class="flex-1 min-w-0">
    <div class="text-sm font-medium truncate {endpoint.error ? 'text-red-500' : ''}">{endpoint.name}</div>
    <div class="flex items-center gap-2 mt-0.5">
      <TransportBadge transport={endpoint.transport} />
      {#if endpoint.error}
        <!-- error state: just show badge, no extra text -->
      {:else if endpoint.disabled}
        <span class="text-xs text-(--color-text-secondary)">Disabled</span>
      {:else}
        <span class="text-xs text-(--color-text-secondary)">{endpoint.tool_count} tools</span>
      {/if}
      {#if oauthStatus}
        <span class="text-xs" title={oauthStatus.status}>{authIcons[oauthStatus.status]}</span>
      {/if}
    </div>
  </div>
</button>

