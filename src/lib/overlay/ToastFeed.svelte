<!--
  Feed container. Subscribes to the toast store, slices to `maxVisible`
  groups (newest at bottom), and inserts a "+N earlier" marker when the
  feed overflows. Position attribute drives the corner anchoring via
  `overlay.css`.
-->
<script lang="ts">
  import type { ToastStore } from './toastStore';
  import {
    hiddenGroupCount,
    visibleGroups,
    type OverlayPosition,
  } from './overlay-helpers';
  import OverlayCard from './OverlayCard.svelte';
  import { fly } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';

  type Props = {
    store: ToastStore;
    position?: OverlayPosition;
    maxVisible?: number;
    cardWidth?: number;
    dismissMs?: number;
    showProfile?: boolean;
  };
  let {
    store,
    position = 'bottom-right',
    maxVisible = 7,
    cardWidth = 340,
    dismissMs = 6000,
    showProfile = true,
  }: Props = $props();

  const groups = $derived($store);
  const visible = $derived(visibleGroups(groups, maxVisible));
  const hidden = $derived(hiddenGroupCount(groups.length, maxVisible));

  // Right-anchored corners slide in/out toward +x, left-anchored toward
  // −x. Magnitude is the card width + the feed's outer padding so the
  // slot fully clears the visible area before the transition ends.
  // 380px = --tf-card-w (340) + .tf-feed horizontal padding (20) + slack.
  // The transition directives live on the per-card slot `<div>` below —
  // the immediate keyed child of `{#each}` — so Svelte plays the outro
  // when the store removes a group. Moving them here from inside
  // OverlayCard.svelte fixes the slide-out no-op: Svelte unmounts a
  // child component synchronously and the transition on its root
  // element never gets a chance to run.
  const slideDir = $derived(position.endsWith('right') ? 1 : -1);
  const slidePx = 380;

  // Honour the OS reduced-motion preference: collapse the slide to a
  // short cross-fade with no horizontal travel. `matchMedia` is gated on
  // `window` because vitest runs this module under node (env=node).
  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const inDuration = reducedMotion ? 120 : 220;
  const outDuration = reducedMotion ? 100 : 200;
  const inX = $derived(reducedMotion ? 0 : slideDir * slidePx);
  const outX = $derived(reducedMotion ? 0 : slideDir * slidePx);

  // Stock `fly` for the outro: translateX + opacity only, no
  // simultaneous height collapse. An earlier custom `slideCollapse`
  // combined translateX with a `max-height: t * height` collapse so the
  // column gap closed during the slide — but with `quintOut` easing the
  // height fell to ~17% in the first 60ms (vs ~59% at 20ms), and the
  // remaining horizontal travel was promptly clipped by
  // `.tf-feed-inner { overflow: hidden }` once translateX exceeded the
  // inner column's 340px width. The combined collapse + clipping read
  // as "vanish" rather than "slide". Dropping the max-height collapse
  // keeps the card at full height for the whole 200ms so the slide and
  // fade are visible; the trade-off is that the row gap closes
  // instantly when the outro completes, not during it.
</script>

<div
  class="tf-feed"
  data-position={position}
  data-testid="toast-feed"
  style:--tf-card-w="{cardWidth}px"
>
  <div class="tf-feed-inner" data-overflow={hidden > 0}>
    {#if hidden > 0}
      <div class="tf-more" data-testid="more-earlier">+{hidden} earlier</div>
    {/if}
    {#each visible as g (g.id)}
      <div
        class="tf-card-slot"
        in:fly={{ x: inX, opacity: 0, duration: inDuration, easing: quintOut }}
        out:fly={{ x: outX, opacity: 0, duration: outDuration, easing: quintOut }}
      >
        <OverlayCard group={g} {dismissMs} {showProfile} />
      </div>
    {/each}
  </div>
</div>
