<script lang="ts">
  import { selectedEndpoint } from '$lib/stores';
  import { getEndpointLogs } from '$lib/api';
  import { mockLogs } from '$lib/mock';

  let lines: string[] = $state([]);
  let loading = $state(true);
  let scrollContainer: HTMLDivElement | undefined = $state();

  $effect(() => {
    const name = $selectedEndpoint;
    if (!name) return;
    loading = true;
    getEndpointLogs(name)
      .then((data) => { lines = data.lines; })
      .catch(() => { lines = mockLogs; })
      .finally(() => {
        loading = false;
        requestAnimationFrame(() => {
          if (scrollContainer) {
            scrollContainer.scrollTop = scrollContainer.scrollHeight;
          }
        });
      });
  });
</script>

<div class="h-full flex flex-col">
  <div class="px-4 py-2 border-b border-(--color-border) flex items-center justify-between">
    <span class="text-xs text-(--color-text-secondary)">{lines.length} lines</span>
  </div>
  <div
    bind:this={scrollContainer}
    class="flex-1 overflow-y-auto p-4 font-mono text-xs leading-5 bg-(--color-surface-alt)"
  >
    {#if loading}
      <div class="space-y-1">
        {#each [1, 2, 3, 4, 5] as _}
          <div class="h-4 w-3/4 rounded bg-(--color-surface-hover) animate-pulse"></div>
        {/each}
      </div>
    {:else}
      {#each lines as line, i}
        <div class="hover:bg-(--color-surface-hover) px-1 rounded whitespace-pre-wrap break-all">{line}</div>
      {/each}
      {#if lines.length === 0}
        <div class="text-(--color-text-secondary) text-center py-6">No logs available</div>
      {/if}
    {/if}
  </div>
</div>

