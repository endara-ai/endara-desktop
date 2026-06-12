<script lang="ts">
  import type { IsolationState } from '$lib/types';
  import { getIsolationBadge } from './endpoint-row-helpers';

  let {
    isolation,
    size = 'sm',
  }: { isolation: IsolationState | null | undefined; size?: 'sm' | 'md' } = $props();

  const badge = $derived(getIsolationBadge(isolation));
</script>

{#if badge}
  <span
    class="iso-badge iso-badge-{size} iso-badge-{badge.kind} inline-flex items-center font-semibold whitespace-nowrap"
    title={badge.title}
  >
    {badge.label}
  </span>
{/if}

<style>
  .iso-badge {
    letter-spacing: 0.02em;
    font-family: var(--font-mono);
  }
  .iso-badge-sm {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 3px;
  }
  .iso-badge-md {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: var(--radius-xs);
  }
  .iso-badge-container {
    background: color-mix(in oklab, var(--healthy) 14%, transparent);
    color: var(--healthy);
  }
  .iso-badge-fallback {
    background: color-mix(in oklab, var(--degraded) 16%, transparent);
    color: var(--degraded);
  }
</style>
