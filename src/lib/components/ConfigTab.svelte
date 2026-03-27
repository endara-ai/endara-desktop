<script lang="ts">
  import { getConfig } from '$lib/api';

  let config = $state('');
  let loading = $state(true);

  $effect(() => {
    loading = true;
    getConfig()
      .then((data) => { config = JSON.stringify(data, null, 2); })
      .catch(() => { config = '# Unable to load config\n# Make sure the relay is running at localhost:9400'; })
      .finally(() => { loading = false; });
  });
</script>

<div class="h-full flex flex-col">
  <div class="px-4 py-2 border-b border-(--color-border)">
    <span class="text-xs text-(--color-text-secondary)">Configuration (read-only)</span>
  </div>
  <div class="flex-1 overflow-y-auto p-4 font-mono text-xs leading-5 bg-(--color-surface-alt)">
    {#if loading}
      <div class="space-y-1">
        {#each [1, 2, 3] as _}
          <div class="h-4 w-1/2 rounded bg-(--color-surface-hover) animate-pulse"></div>
        {/each}
      </div>
    {:else}
      <pre class="whitespace-pre-wrap break-all">{config}</pre>
    {/if}
  </div>
</div>

