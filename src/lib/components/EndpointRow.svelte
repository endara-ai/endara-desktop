<script lang="ts">
  import type { Endpoint, OAuthStatusValue } from '$lib/types';
  import { selectedEndpoint, oauthStatuses } from '$lib/stores';
  import HealthDot from './HealthDot.svelte';
  import EndpointIcon from './EndpointIcon.svelte';
  import TransportBadge from './TransportBadge.svelte';
  import FailedEndpointBadge from './FailedEndpointBadge.svelte';

  let { endpoint }: { endpoint: Endpoint } = $props();

  const authLabels: Record<OAuthStatusValue, string> = {
    authenticated: 'Authenticated',
    refreshing: 'Refreshing token…',
    auth_required: 'Authentication required',
    needs_login: 'Login required',
    disconnected: 'Disconnected',
    connection_failed: 'Connection failed',
  };

  const authIcons: Record<OAuthStatusValue, string> = {
    authenticated: '<svg class="inline-block w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 7V4.5a2.5 2.5 0 0 0-5 0V7"/><rect x="4" y="7" width="8" height="6.5" rx="1.5"/><circle cx="8" cy="10.5" r="1" fill="currentColor" stroke="none"/></svg>',
    refreshing: '<svg class="inline-block w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8A5 5 0 1 1 8 3"/><path d="M13 3v5h-5"/></svg>',
    auth_required: '<svg class="inline-block w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/><circle cx="8" cy="10.5" r="1" fill="currentColor" stroke="none"/></svg>',
    needs_login: '<svg class="inline-block w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/><circle cx="8" cy="10.5" r="1" fill="currentColor" stroke="none"/></svg>',
    disconnected: '<svg class="inline-block w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5.5v3.5"/><circle cx="8" cy="11.5" r="0.75" fill="currentColor" stroke="none"/><path d="M3 13.5L8 3l5 10.5H3z"/></svg>',
    connection_failed: '<svg class="inline-block w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5.5v3.5"/><circle cx="8" cy="11.5" r="0.75" fill="currentColor" stroke="none"/><path d="M3 13.5L8 3l5 10.5H3z"/></svg>',
  };

  let oauthStatus = $derived(
    endpoint.transport === 'oauth' ? $oauthStatuses.get(endpoint.name) : undefined
  );

  // Extract error message from lifecycle if it's in Failed state
  let lifecycleError = $derived(
    endpoint.lifecycle?.state === 'Failed' ? endpoint.lifecycle.error?.detail : undefined
  );

  // Combined error message for display
  let errorMessage = $derived(endpoint.error || lifecycleError || 'Unknown error');

  // Whether the endpoint is in a failed/error state
  let isFailed = $derived(!!endpoint.error || endpoint.health === 'error' || endpoint.health === 'failed');

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
      <HealthDot health={isFailed ? 'error' : endpoint.health} />
    </span>
  </div>
  <div class="flex-1 min-w-0">
    <div class="text-sm font-medium truncate {isFailed ? 'text-red-500' : ''}">{endpoint.name}</div>
    <div class="flex items-center gap-2 mt-0.5">
      <TransportBadge transport={endpoint.transport} />
      {#if isFailed}
        <FailedEndpointBadge error={errorMessage} />
        <span class="text-xs text-red-500 truncate max-w-[120px]" title={errorMessage}>
          {errorMessage}
        </span>
      {:else if endpoint.disabled}
        <span class="text-xs text-(--color-text-secondary)">Disabled</span>
      {:else}
        <span class="text-xs text-(--color-text-secondary)">{endpoint.tool_count} tools</span>
      {/if}
      {#if oauthStatus}
        <span class="text-xs" title={authLabels[oauthStatus.status]}>{@html authIcons[oauthStatus.status]}</span>
      {/if}
    </div>
  </div>
</button>

