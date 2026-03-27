<script lang="ts">
  import type { Endpoint } from '$lib/types';
  import { selectedEndpoint } from '$lib/stores';
  import HealthDot from './HealthDot.svelte';
  import TransportBadge from './TransportBadge.svelte';

  let { endpoint }: { endpoint: Endpoint } = $props();

  function select() {
    selectedEndpoint.set(endpoint.name);
  }
</script>

<button
  class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors
    hover:bg-(--color-surface-hover)
    {$selectedEndpoint === endpoint.name ? 'bg-(--color-surface-hover)' : ''}"
  onclick={select}
>
  <HealthDot health={endpoint.health} />
  <div class="flex-1 min-w-0">
    <div class="text-sm font-medium truncate">{endpoint.name}</div>
    <div class="flex items-center gap-2 mt-0.5">
      <TransportBadge transport={endpoint.transport} />
      <span class="text-xs text-(--color-text-secondary)">{endpoint.tool_count} tools</span>
    </div>
  </div>
</button>

