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

  // Feed-level dismiss progress bar state. The store bumps `dismissReset`
  // every time the idle timer is (re)armed; we key the bar's fill on
  // `tick` so Svelte's `{#key dismissTick}` re-mounts the element and
  // the CSS keyframe restarts at 0%. `dismissPaused` flips on overlay
  // hover and freezes the fill via `animation-play-state: paused`.
  // `durationMs` is captured at arm time in the store, so it stays
  // aligned with the timer that will fire. Wrapped in `$derived` to
  // satisfy Svelte 5's runes warning about capturing `store` only on
  // initial render. The bar lives at a stable DOM location (sibling of
  // the cards, last child of `.tf-feed-inner`) so group reorders
  // triggered by `addStarted` don't unmount-remount the bar on
  // different cards — that mid-animation churn was the root cause of
  // the stuck-progress regression. CSS in `overlay.css` collapses the
  // 8px flex gap so the bar still reads as fused to the bottommost
  // card's bottom edge at all four anchor corners.
  const dismissReset = $derived(store.dismissReset);
  const dismissPaused = $derived(store.dismissPaused);
  const dismissTick = $derived($dismissReset.tick);
  const dismissDurationMs = $derived($dismissReset.durationMs);
  const dismissPausedNow = $derived($dismissPaused);

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
</script>

<div
  class="tf-feed"
  data-position={position}
  data-testid="toast-feed"
  style:--tf-card-w="{cardWidth}px"
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
        <div class="tf-card-slot" in:fade={{ duration: 120 }}>
          <OverlayCard group={g} {showProfile} />
        </div>
      {/each}
      <!--
        Feed-level dismiss progress bar. Rendered as a sibling AFTER
        the cards so its DOM location is stable regardless of how
        groups reorder (the `addStarted` reshuffle in `toastStore`
        used to move the bar between cards mid-animation, freezing
        the CSS keyframe). The `{#key dismissTick}` re-mounts the
        inner fill on every idle-timer (re)arm so the keyframe
        restarts at 0%. `overlay.css` gives the bar a negative
        top margin to absorb the 8px flex gap above it so it sits
        flush against the bottommost card's bottom edge, and a
        position-keyed `order` flip handles the `column-reverse`
        layout used by the top-anchored corners.
      -->
      {#key dismissTick}
        <div class="tf-dismiss-bar" data-testid="dismiss-bar">
          <div
            class="tf-dismiss-fill"
            data-testid="dismiss-fill"
            style:animation-duration="{dismissDurationMs}ms"
            style:animation-play-state={dismissPausedNow ? 'paused' : 'running'}
          ></div>
        </div>
      {/key}
    </div>
  {/if}
</div>
