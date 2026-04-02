<script lang="ts">
  import type { HealthStatus } from '$lib/types';

  let { health }: { health: HealthStatus } = $props();

  const colorMap: Record<HealthStatus, string> = {
    healthy: 'bg-(--color-healthy)',
    degraded: 'bg-(--color-degraded)',
    offline: 'bg-(--color-offline)',
    unknown: 'bg-gray-400',
    error: 'bg-red-500',
  };

  const titleMap: Record<HealthStatus, string> = {
    healthy: 'healthy',
    degraded: 'degraded',
    offline: 'offline',
    unknown: 'Starting…',
    error: 'Error',
  };
</script>

{#if health === 'unknown'}
  <span class="inline-block w-2.5 h-2.5" title={titleMap[health]}>
    <svg
      class="w-full h-full animate-spin text-gray-400"
      viewBox="0 0 16 16"
      fill="none"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        stroke-width="3"
        stroke-dasharray="28"
        stroke-dashoffset="8"
        stroke-linecap="round"
      />
    </svg>
  </span>
{:else}
  <span
    class="inline-block w-2.5 h-2.5 rounded-full {colorMap[health]}"
    title={titleMap[health]}
  ></span>
{/if}
