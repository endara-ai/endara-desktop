<script lang="ts">
  import type { Endpoint } from '$lib/types';
  import { selectedEndpoint } from '$lib/stores';
  import HealthDot from './HealthDot.svelte';
  import EndpointIcon from './EndpointIcon.svelte';
  import TransportBadge from './TransportBadge.svelte';

  let { endpoint }: { endpoint: Endpoint } = $props();

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
  class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left transition-colors
    hover:bg-(--hover-bg)
    {$selectedEndpoint === endpoint.name ? 'bg-(--hover-bg)' : ''}
    {endpoint.disabled ? 'opacity-50' : ''}"
  onclick={select}
>
  <div class="relative flex-shrink-0 text-(--fg3)" style="width: 20px; height: 20px;">
    <EndpointIcon {endpoint} size={20} />
    <span class="absolute" style="bottom: -1px; right: -1px;">
      <HealthDot health={isFailed ? 'error' : endpoint.health} stacked={true} />
    </span>
  </div>
  <div class="flex-1 min-w-0">
    <div
      class="text-[13px] font-medium truncate {isFailed ? 'text-(--offline)' : 'text-(--fg1)'}"
    >{endpoint.name}</div>
    <div class="flex items-center gap-1.5 mt-px">
      <TransportBadge transport={endpoint.transport} />
      {#if isFailed}
        <span
          class="text-[11px] text-(--offline) truncate max-w-[120px]"
          style="font-family: var(--font-mono);"
          title={errorMessage}
        >
          {errorMessage}
        </span>
      {:else if endpoint.disabled}
        <span class="text-[11px] text-(--fg3)" style="font-family: var(--font-mono);">Disabled</span>
      {:else}
        <span class="text-[11px] text-(--fg3)" style="font-family: var(--font-mono);">{endpoint.tool_count} tools</span>
      {/if}
    </div>
  </div>
</button>

