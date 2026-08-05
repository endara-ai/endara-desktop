<script lang="ts" generics="T">
  import { tick, untrack } from 'svelte';
  import type { Snippet } from 'svelte';
  import { get } from 'svelte/store';
  import { createVirtualizer } from '@tanstack/svelte-virtual';
  import {
    DEFAULT_OVERSCAN,
    DEFAULT_ROW_ESTIMATE_PX,
    becameVisible,
    isPinnedToBottom,
    itemKeyAt,
    shouldStickToBottom,
  } from './virtual-log-list-helpers';

  // Shared virtualized log list built on @tanstack/svelte-virtual. Renders
  // only the visible rows (+ overscan) with dynamic measured heights, and
  // exposes the pinned-to-bottom / scroll-to-bottom API the log views use to
  // drive their auto-scroll and "Go to end" affordances.

  type Props = {
    /** Rows to render. Only the windowed subset is mounted. */
    items: readonly T[];
    /** Stable string key per item — wired into the virtualizer's getItemKey. */
    getKey: (item: T, index: number) => string;
    /** Rows rendered above/below the viewport. Defaults to 10. */
    overscan?: number;
    /** Row renderer, receives (item, index). */
    row: Snippet<[T, number]>;
    /** Called when the pinned-to-bottom state flips (isAtBottom semantics). */
    onscrollstate?: (pinned: boolean) => void;
    /** Extra classes for the scroll container (sizing, colors, ...). */
    class?: string;
  };

  let {
    items,
    getKey,
    overscan = DEFAULT_OVERSCAN,
    row,
    onscrollstate,
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

  // Keep options in sync when items grow/shrink/are replaced, without
  // recreating the virtualizer (which would drop its measurement cache).
  $effect(() => {
    const count = items.length;
    const os = overscan;
    get(virtualizer).setOptions({ count, overscan: os });
  });

  // Follow the tail when pinned: appends and wholesale replacements keep the
  // view at the bottom, matching the existing auto-scroll behavior.
  $effect(() => {
    const count = items.length;
    const store = virtualizer;
    if (!shouldStickToBottom(untrack(() => pinned), count)) return;
    tick().then(() => {
      if (!pinned) return;
      const inst = get(store);
      inst.scrollToOffset(inst.getTotalSize(), { align: 'end' });
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
      if (pinned) {
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

  /** Re-pin and scroll to the last item (drives "Go to end"). */
  export function scrollToBottom() {
    if (!pinned) {
      pinned = true;
      onscrollstate?.(true);
    }
    tick().then(() => {
      const inst = get(virtualizer);
      inst.scrollToOffset(inst.getTotalSize(), { align: 'end' });
    });
  }

  /** Whether the view is currently pinned to the bottom. */
  export function isPinned(): boolean {
    return pinned;
  }
</script>

<div bind:this={scrollEl} onscroll={handleScroll} class="overflow-y-auto {className}">
  <div class="relative w-full" style:height="{$virtualizer.getTotalSize()}px">
    {#each $virtualizer.getVirtualItems() as vItem, i (vItem.key)}
      {@const item = items[vItem.index]}
      <div
        bind:this={rowEls[i]}
        data-index={vItem.index}
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
