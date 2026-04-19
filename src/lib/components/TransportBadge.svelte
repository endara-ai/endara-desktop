<script lang="ts">
  let {
    transport,
    size = 'sm',
  }: { transport: string; size?: 'sm' | 'md' } = $props();

  const colorMap: Record<string, string> = {
    stdio: 'bg-(--trans-stdio-bg) text-(--trans-stdio-fg)',
    sse: 'bg-(--trans-sse-bg) text-(--trans-sse-fg)',
    http: 'bg-(--trans-http-bg) text-(--trans-http-fg)',
    oauth: 'bg-(--trans-oauth-bg) text-(--trans-oauth-fg)',
  };

  const colorClass = $derived(colorMap[transport] ?? 'bg-(--surface-alt) text-(--fg2)');
</script>

<span
  class="ep-trans ep-trans-{size} inline-flex items-center uppercase font-semibold {colorClass}"
>
  {transport}
</span>

<style>
  .ep-trans {
    letter-spacing: 0.08em;
    font-family: var(--font-mono);
    line-height: 1;
  }
  .ep-trans-sm {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 3px;
  }
  .ep-trans-md {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: var(--radius-xs);
  }
</style>

