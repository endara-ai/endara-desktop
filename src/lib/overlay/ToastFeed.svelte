<!--
  Feed container. Subscribes to the toast store, slices to `maxVisible`
  groups (newest at bottom), and inserts a "+N earlier" marker when the
  feed overflows. Position attribute drives the corner anchoring via
  `overlay.css`.
-->
<script lang="ts">
  import type { ToastStore } from './toastStore';
  import {
    collectHitRects,
    hiddenGroupCount,
    latestRequest,
    visibleGroups,
    type OverlayPosition,
  } from './overlay-helpers';
  import { reportOverlayHitRects } from './overlay-actions';
  import OverlayCard from './OverlayCard.svelte';
  import { fade, fly } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';

  type Props = {
    store: ToastStore;
    position?: OverlayPosition;
    maxVisible?: number;
    cardWidth?: number;
    showProfile?: boolean;
  };
  let {
    store,
    position = 'bottom-right',
    maxVisible = 7,
    cardWidth = 340,
    showProfile = true,
  }: Props = $props();

  const groups = $derived($store);
  const visible = $derived(visibleGroups(groups, maxVisible));
  const hidden = $derived(hiddenGroupCount(groups.length, maxVisible));

  // Per-card dismiss bar lives inside `OverlayCard` and reads its
  // timing state from `group.dismissTick` + `group.inflight`/
  // `group.success`/`group.error`. The duration captured by the
  // matching `setTimeout` in `toastStore` is exposed via
  // `store.getOpts().dismissMs` and piped down so the CSS keyframe
  // and the JS timeout stay aligned.
  const dismissDurationMs = $derived(store.getOpts().dismissMs);

  // Right-anchored corners slide in/out toward +x, left-anchored toward
  // −x. The transition directives live on the `.tf-feed-inner` container
  // gated by `{#if visible.length > 0}` so the WHOLE stack slides in on
  // 0 → ≥1 and slides out on ≥1 → 0 as one coherent unit. Individual
  // cards 1 → N fade in subtly via a local `in:fade` on the per-card slot.
  //
  // Magnitude (80px) is intentionally short of a full off-screen exit.
  // The Tauri overlay window is 400 logical px wide (see
  // `OVERLAY_WIDTH` in `src-tauri/src/overlay.rs`) and sits flush
  // against the monitor edge, so the right-anchored `.tf-feed`
  // (`--tf-card-w` + 40 = 380px) only has ~20 logical px of slack to
  // the screen edge before the OS compositor clips translated content.
  // A larger slide is clipped almost immediately and reads as "vanish".
  // Paired with the `overflow-x: visible` change on `.tf-feed-inner` in
  // `overlay.css`, 80px gives a clearly observable horizontal motion at
  // all four corners without hitting the compositor clip.
  const slideDir = $derived(position.endsWith('right') ? 1 : -1);
  const slidePx = 80;

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

  // ---- Hit-rect reporting --------------------------------------------------
  // Measure the visible card slots and report their bounding rects to the
  // Rust-side cursor poller (`set_overlay_hit_rects`). The poller — not a
  // renderer pointer handler — toggles the window's ignore-cursor-events
  // flag, because a click-through window receives no pointer events from
  // the OS. An empty report idles the poller and restores click-through.
  //
  // Two-step measurement: a rAF captures the new layout as soon as it
  // exists, and a delayed re-measure after the slide/fade transitions have
  // settled (`inDuration` + margin) captures the final card positions (the
  // feed-level fly translates the whole stack horizontally while animating).
  let feedEl: HTMLElement | null = $state(null);
  let measureRaf = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  function measureAndReport() {
    const slots = feedEl ? feedEl.querySelectorAll('.tf-card-slot') : [];
    void reportOverlayHitRects(collectHitRects(slots));
  }

  function scheduleHitRectMeasure() {
    if (typeof window === 'undefined') return;
    cancelAnimationFrame(measureRaf);
    measureRaf = requestAnimationFrame(measureAndReport);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(measureAndReport, inDuration + 120);
  }

  // Re-measure whenever the visible card list (or the "+N earlier" row)
  // changes. The settle-timer pass also covers the 1 → 0 case where the
  // out-transition keeps slot elements in the DOM briefly.
  $effect(() => {
    void visible;
    void hidden;
    scheduleHitRectMeasure();
  });

  // Re-measure on window resize (monitor / scale changes move the cards).
  $effect(() => {
    const onResize = () => scheduleHitRectMeasure();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(measureRaf);
      clearTimeout(settleTimer);
    };
  });
</script>

<div
  class="tf-feed"
  data-position={position}
  data-testid="toast-feed"
  style:--tf-card-w="{cardWidth}px"
  bind:this={feedEl}
>
  {#if visible.length > 0}
    <div
      class="tf-feed-inner"
      data-overflow={hidden > 0}
      in:fly={{ x: inX, opacity: 0, duration: inDuration, easing: quintOut }}
      out:fly={{ x: outX, opacity: 0, duration: outDuration, easing: quintOut }}
    >
      {#if hidden > 0}
        <div class="tf-more" data-testid="more-earlier">+{hidden} earlier</div>
      {/if}
      {#each visible as g (g.id)}
        <div
          class="tf-card-slot"
          data-log-id={latestRequest(g)?.jsonrpcId ?? ''}
          in:fade={{ duration: 120 }}
        >
          <OverlayCard group={g} {showProfile} {dismissDurationMs} />
        </div>
      {/each}
    </div>
  {/if}
</div>
