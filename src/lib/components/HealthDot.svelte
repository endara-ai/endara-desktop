<script lang="ts">
  import type { HealthStatus } from '$lib/types';

  let { health }: { health: HealthStatus } = $props();

  const colorMap: Record<HealthStatus, string> = {
    healthy: 'bg-(--color-healthy)',
    degraded: 'bg-(--color-degraded)',
    offline: 'bg-(--color-offline)',
    unknown: 'bg-gray-400',
  };
</script>

<span
  class="inline-block w-2.5 h-2.5 rounded-full {colorMap[health]} {health === 'healthy' ? 'animate-pulse-dot' : ''}"
  title={health}
></span>

