<!--
  Tri-state status icon: spinner / check / cross. Mirrors the prototype's
  `StateIcon` (toast-feed.jsx lines 251–273) in Svelte.
-->
<script lang="ts">
  import type { GroupVisualState } from './overlay-helpers';

  type Props = { state: GroupVisualState; color: string; size?: number };
  let { state, color, size = 14 }: Props = $props();
</script>

<!--
  Decorative — adjacent text (tool name, server name, duration / counts on
  the parent card) already conveys the state to assistive tech. Marking the
  SVG `aria-hidden` keeps screen readers from announcing the bare shape.
-->
{#if state === 'inflight'}
  <svg
    width={size}
    height={size}
    viewBox="0 0 14 14"
    style:color
    style:animation="tfSpin 0.9s linear infinite"
    data-testid="state-icon"
    data-state="inflight"
    aria-hidden="true"
  >
    <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" opacity="0.18" stroke-width="1.6" />
    <path d="M7 1.5 A 5.5 5.5 0 0 1 12.5 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  </svg>
{:else if state === 'success'}
  <svg width={size} height={size} viewBox="0 0 14 14" style:color data-testid="state-icon" data-state="success" aria-hidden="true">
    <path d="M3 7.2l2.7 2.6 5.4-5.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
{:else}
  <svg width={size} height={size} viewBox="0 0 14 14" style:color data-testid="state-icon" data-state="fail" aria-hidden="true">
    <path d="M3.8 3.8l6.4 6.4M10.2 3.8l-6.4 6.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
  </svg>
{/if}
