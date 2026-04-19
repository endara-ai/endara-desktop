<script lang="ts">
  import { endpoints, miniPlayerMode } from '$lib/stores';
  import HealthDot from './HealthDot.svelte';

  let healthyCt = $derived($endpoints.filter((e) => e.health === 'healthy').length);
  let totalCt = $derived($endpoints.length);
</script>

<div class="fixed bottom-4 right-4 z-40 bg-(--surface) border border-(--border) rounded-xl shadow-lg p-3 w-56">
  <div class="flex items-center justify-between mb-2">
    <span class="text-xs font-semibold text-(--fg2)">Endara</span>
    <button
      class="text-xs text-(--accent) hover:underline"
      onclick={() => miniPlayerMode.set(false)}
    >Expand</button>
  </div>
  <div class="flex items-center gap-2">
    <HealthDot health={healthyCt === totalCt ? 'healthy' : healthyCt > 0 ? 'degraded' : 'offline'} />
    <span class="text-sm">{healthyCt}/{totalCt} healthy</span>
  </div>
  {#if $endpoints.length > 0}
    <div class="mt-2 space-y-1">
      {#each $endpoints.slice(0, 3) as ep}
        <div class="flex items-center gap-1.5 text-xs">
          <HealthDot health={ep.health} />
          <span class="truncate">{ep.name}</span>
        </div>
      {/each}
      {#if $endpoints.length > 3}
        <div class="text-xs text-(--fg2)">+{$endpoints.length - 3} more</div>
      {/if}
    </div>
  {/if}
</div>

