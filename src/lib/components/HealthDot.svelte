<script lang="ts">
  import type { HealthStatus } from '$lib/types';

  let {
    health,
    stacked = false,
  }: { health: HealthStatus; stacked?: boolean } = $props();

  const colorMap: Record<HealthStatus, string> = {
    healthy: 'bg-(--healthy)',
    degraded: 'bg-(--degraded)',
    offline: 'bg-(--offline)',
    unknown: 'bg-gray-400',
    error: 'bg-(--offline)',
    failed: 'bg-(--offline)',
    starting: 'bg-(--accent)',
  };

  const titleMap: Record<HealthStatus, string> = {
    healthy: 'healthy',
    degraded: 'degraded',
    offline: 'offline',
    unknown: 'Unknown',
    error: 'Error',
    failed: 'Failed',
    starting: 'Starting…',
  };

  const spinnerColorMap: Partial<Record<HealthStatus, string>> = {
    unknown: 'text-gray-400',
    starting: 'text-(--accent)',
  };

  const sizeClass = $derived(stacked ? 'w-2 h-2' : 'w-2.5 h-2.5');
  const ringStyle = $derived(stacked ? 'border: 2px solid var(--ring-stroke); box-sizing: border-box;' : '');
</script>

{#if health === 'unknown' || health === 'starting'}
  <span class="inline-block {sizeClass}" title={titleMap[health]}>
    <svg
      class="w-full h-full animate-spin {spinnerColorMap[health]}"
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
    class="inline-block {sizeClass} rounded-full {colorMap[health]}"
    style={ringStyle}
    title={titleMap[health]}
  ></span>
{/if}
