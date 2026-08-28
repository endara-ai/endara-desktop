<script lang="ts" generics="T">
  import { tick, untrack } from 'svelte';
  import type { Snippet } from 'svelte';
  import { get } from 'svelte/store';
  import { createVirtualizer } from '@tanstack/svelte-virtual';
  import {
    DEFAULT_OVERSCAN,
    DEFAULT_ROW_ESTIMATE_PX,
    becameVisible,
    captureScrollAnchor,
    findIndexByKey,
    isPinnedToBottom,
    itemKeyAt,
    restoredScrollTop,
    shouldRepinOnUnhide,
    shouldReportInitialPinned,
    shouldStickToBottom,
    type ScrollAnchor,
  } from './virtual-log-list-helpers';

  // Shared virtualized log list built on @tanstack/svelte-virtual. Renders
  // only the visible rows (+ overscan) with dynamic measured heights, and
  // exposes the pinned-to-bottom / scroll-to-bottom API the log views use to
  // drive their auto-scroll and "Go to end" affordances.

  type Props = {
    /**
     * Rows to render. Only the windowed subset is mounted. Must be REPLACED
     * (new array) on change, never mutated in place: the effects below track
     * the prop reference, so an in-place mutation (same array, same length)
     * is invisible to the count sync, tail-follow, and scroll re-anchoring.
     * Every consumer already does this (mergeCalls & co. return new arrays).
     */
    items: readonly T[];
    /** Stable string key per item — wired into the virtualizer's getItemKey. */
    getKey: (item: T, index: number) => string;
    /** Rows rendered above/below the viewport. Defaults to 10. */
    overscan?: number;
    /** Row renderer, receives (item, index). */
    row: Snippet<[T, number]>;
    /** Called when the pinned-to-bottom state flips (isAtBottom semantics). */
    onscrollstate?: (pinned: boolean) => void;
    /**
     * Tail-pinned log semantics (default). When false the list is a plain
     * top-anchored virtualized list: no tail-follow on item changes, no
     * re-pin on unhide, no initial pinned report.
     */
    followTail?: boolean;
    /**
     * ARIA role for the scroll container (e.g. "rowgroup" when the rows are
     * ARIA table rows). The internal spacer/positioner divs are marked
     * role="presentation" so the owned-element chain (table → rowgroup →
     * row) stays intact for assistive tech.
     */
    role?: string;
    /** Extra classes for the scroll container (sizing, colors, ...). */
    class?: string;
  };

  let {
    items,
    getKey,
    overscan = DEFAULT_OVERSCAN,
    row,
    onscrollstate,
    followTail = true,
    role = undefined,
    class: className = '',
  }: Props = $props();

  let scrollEl: HTMLDivElement | undefined = $state();
  let rowEls: (HTMLElement | null)[] = $state([]);
  let pinned = $state(true);

  // TanStack/virtual#866 workaround: option callbacks like getScrollElement
  // are not reactive under Svelte 5 runes, so the virtualizer is constructed
  // in a $derived that reads the bound scroll element at its top level — the
  // derived re-runs (and the template re-subscribes) once bind:this delivers
  // the element. Everything else is read via untrack so items/overscan
  // changes update options in place instead of recreating the virtualizer.
  const virtualizer = $derived.by(() => {
    const el = scrollEl;
    return createVirtualizer<HTMLDivElement, HTMLElement>({
      count: untrack(() => items.length),
      getScrollElement: el ? () => el : () => null,
      estimateSize: () => DEFAULT_ROW_ESTIMATE_PX,
      overscan: untrack(() => overscan),
      getItemKey: (index) => untrack(() => itemKeyAt(items, index, getKey)),
    });
  });

  // Top-anchored re-anchor, part 1 (capture): live merges PREPEND rows and
  // the transform-positioned virtual rows defeat native scroll anchoring, so
  // content under the cursor would shift down on every merge. Before the new
  // items render ($effect.pre runs ahead of DOM updates and the count-sync
  // effect below, so getVirtualItems() still reflects the OLD layout),
  // remember the first visible row's key + viewport offset. Tail-follow mode
  // and scrollTop 0 capture nothing (see captureScrollAnchor).
  let pendingAnchor: ScrollAnchor | null = null;
  $effect.pre(() => {
    void items.length;
    const follow = followTail;
    const el = scrollEl;
    if (!el) {
      pendingAnchor = null;
      return;
    }
    const rows = get(virtualizer)
      .getVirtualItems()
      .map((v) => ({ key: String(v.key), start: v.start, end: v.end }));
    pendingAnchor = captureScrollAnchor(follow, el.scrollTop, rows);
  });

  // Keep options in sync when items grow/shrink/are replaced, without
  // recreating the virtualizer (which would drop its measurement cache).
  $effect(() => {
    const count = items.length;
    const os = overscan;
    get(virtualizer).setOptions({ count, overscan: os });
  });

  // Top-anchored re-anchor, part 2 (restore): after the merge rendered,
  // scroll so the captured row sits at the same viewport offset again. If
  // the row vanished (evicted by the consumer's live cap) or nothing moved
  // (append-only merge), this is a no-op.
  $effect(() => {
    void items.length;
    const store = virtualizer;
    const anchor = pendingAnchor;
    pendingAnchor = null;
    if (!anchor) return;
    tick().then(() => {
      const el = scrollEl;
      if (!el) return;
      const inst = get(store);
      // Refresh the measurement cache before reading row offsets.
      inst.getVirtualItems();
      const index = findIndexByKey(items, anchor.key, getKey);
      const newStart = index === -1 ? null : (inst.measurementsCache[index]?.start ?? null);
      const target = restoredScrollTop(anchor, newStart, el.scrollTop);
      if (target !== null) inst.scrollToOffset(target);
    });
  });

  // Report the initial pinned state once the scroll element is bound, so a
  // parent that keeps the state across {#if} remounts (e.g. RelayLogs'
  // autoScroll) resyncs with the fresh instance — handleScroll only
  // notifies on flips.
  let reportedInitialPinned = false;
  $effect(() => {
    // followTail is read tracked (like scrollEl) so toggling the prop after
    // mount re-evaluates the effect; pinned stays untracked.
    const follow = followTail;
    if (
      !shouldReportInitialPinned(scrollEl !== undefined, reportedInitialPinned, follow)
    )
      return;
    reportedInitialPinned = true;
    onscrollstate?.(untrack(() => pinned));
  });

  // Follow the tail when pinned: appends and wholesale replacements keep the
  // view at the bottom, matching the existing auto-scroll behavior. Skipped
  // while hidden (0-height viewport) — the visibility observer below re-pins
  // on unhide.
  $effect(() => {
    const count = items.length;
    const store = virtualizer;
    // followTail is read tracked so flipping the prop re-runs tail-follow;
    // pinned stays untracked (scroll flips must not retrigger this effect).
    const follow = followTail;
    if (
      !shouldStickToBottom(
        untrack(() => pinned),
        count,
        scrollEl?.clientHeight ?? 0,
        follow,
      )
    )
      return;
    tick().then(() => {
      if (!pinned) return;
      const inst = get(store);
      inst.scrollToOffset(inst.getTotalSize(), { align: 'end' });
      // The jump above can land short when unmeasured tail rows wrap and
      // measure taller than the estimate; correct on the next frame while
      // still pinned so residual drift can't unpin tail-follow.
      requestAnimationFrame(() => {
        if (!pinned) return;
        const next = get(store);
        next.scrollToOffset(next.getTotalSize(), { align: 'end' });
      });
    });
  });

  // Measure mounted rows for dynamic heights (rows wrap, so fixed estimates
  // are not enough). Same pattern as the official svelte-virtual dynamic
  // example; measureElement attaches a ResizeObserver per row, and re-runs
  // here when the row set or the virtualizer instance changes.
  $effect(() => {
    const inst = get(virtualizer);
    for (const el of rowEls) {
      if (el) inst.measureElement(el);
    }
  });

  // display:none support: rows observed while hidden report 0-height, so on
  // the first non-zero viewport flush the measurement cache and re-pin.
  $effect(() => {
    const el = scrollEl;
    if (!el) return;
    const store = virtualizer;
    let prevHeight = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const nextHeight = el.clientHeight;
      const shown = becameVisible(prevHeight, nextHeight);
      prevHeight = nextHeight;
      if (!shown) return;
      get(store).measure();
      if (shouldRepinOnUnhide(pinned, followTail)) {
        tick().then(() => {
          const inst = get(store);
          inst.scrollToOffset(inst.getTotalSize(), { align: 'end' });
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  });

  function handleScroll() {
    if (!scrollEl) return;
    const next = isPinnedToBottom(
      scrollEl.scrollTop,
      scrollEl.scrollHeight,
      scrollEl.clientHeight,
    );
    if (next !== pinned) {
      pinned = next;
      onscrollstate?.(next);
    }
  }

  /**
   * Re-pin and scroll to the last item (drives "Go to end"). Always reports
   * pinned=true so parents resync even if this instance never flipped (e.g.
   * a fresh mount after an {#if} remount).
   */
  export function scrollToBottom() {
    pinned = true;
    onscrollstate?.(true);
    tick().then(() => {
      const inst = get(virtualizer);
      inst.scrollToOffset(inst.getTotalSize(), { align: 'end' });
    });
  }
</script>

<div bind:this={scrollEl} onscroll={handleScroll} {role} class="overflow-y-auto {className}">
  <div role="presentation" class="relative w-full" style:height="{$virtualizer.getTotalSize()}px">
    {#each $virtualizer.getVirtualItems() as vItem, i (vItem.key)}
      {@const item = items[vItem.index]}
      <div
        bind:this={rowEls[i]}
        data-index={vItem.index}
        role="presentation"
        class="absolute top-0 left-0 w-full"
        style:transform="translateY({vItem.start}px)"
      >
        {#if item !== undefined}
          {@render row(item, vItem.index)}
        {/if}
      </div>
    {/each}
  </div>
</div>
