import { isAtBottom } from '$lib/scrollUtils';

/**
 * Pure helpers backing `VirtualLogList.svelte` — the shared virtualized log
 * list built on `@tanstack/svelte-virtual`. Extracted as plain functions so
 * the glue logic can be exercised in the Node test env, following the same
 * pattern as the rest of this folder (logs-tab-helpers, relay-logs-helpers,
 * tool-call-row-helpers, ...).
 */

/** Default number of rows rendered above/below the visible viewport. */
export const DEFAULT_OVERSCAN = 10;

/**
 * Initial per-row height estimate (px) handed to the virtualizer's
 * `estimateSize`. Log rows wrap (`whitespace-pre-wrap break-all`), so this is
 * only a starting guess — `measureElement` replaces it with the real height
 * once a row is mounted.
 */
export const DEFAULT_ROW_ESTIMATE_PX = 20;

/**
 * Stable string key for the virtualizer's `getItemKey`. Delegates to the
 * consumer-supplied `getKey`, guarding against transiently out-of-range
 * indexes (the virtualizer's `count` is synced to `items.length` in an
 * effect, so a shrink can leave the old count visible for one frame).
 */
export function itemKeyAt<T>(
  items: readonly T[],
  index: number,
  getKey: (item: T, index: number) => string,
): string {
  const item = items[index];
  return item === undefined ? `__vll-missing-${index}` : getKey(item, index);
}

/**
 * Pinned-to-bottom decision for the scroll-state callback. Reuses the
 * `isAtBottom` semantics from `$lib/scrollUtils` (within 40px of the bottom
 * counts as pinned) so the shared component behaves exactly like the
 * hand-rolled auto-scroll in RelayLogs / LogsTab.
 */
export function isPinnedToBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  return isAtBottom(scrollTop, scrollHeight, clientHeight);
}

/**
 * Whether the list should follow the tail after `items` changed (append,
 * wholesale replace). Only in tail-follow mode (`followTail`), when the user
 * is pinned and there is something to scroll to — a Clear (count 0) has
 * nothing to follow — and the viewport has a real height: under a
 * `display:none` ancestor `clientHeight` is 0 and any scroll work is a dead
 * no-op (the visibility ResizeObserver re-pins on unhide instead).
 */
export function shouldStickToBottom(
  pinned: boolean,
  count: number,
  viewportHeight: number,
  followTail = true,
): boolean {
  return followTail && pinned && count > 0 && viewportHeight > 0;
}

/**
 * Whether the component should report its initial pinned state to the
 * parent. `handleScroll` only notifies on flips, so after an `{#if}` remount
 * a fresh list (pinned = true) would leave a parent holding a stale value
 * (e.g. a stuck "Go to end" button). Report once, as soon as the scroll
 * element is bound. Top-anchored mode (`followTail = false`) has no
 * tail-pinned contract to resync, so it never reports.
 */
export function shouldReportInitialPinned(
  hasScrollEl: boolean,
  alreadyReported: boolean,
  followTail = true,
): boolean {
  return followTail && hasScrollEl && !alreadyReported;
}

/**
 * Whether the visibility ResizeObserver should re-pin to the bottom after
 * the list becomes visible again (0 → non-zero viewport height). Only in
 * tail-follow mode and while the user is still pinned.
 */
export function shouldRepinOnUnhide(pinned: boolean, followTail = true): boolean {
  return followTail && pinned;
}

/**
 * Whether a viewport height transition means the list just became visible
 * (e.g. a `display:none` ancestor was shown). Used to trigger a re-measure,
 * since rows observed while hidden report 0-height.
 */
export function becameVisible(prevHeight: number, nextHeight: number): boolean {
  return prevHeight === 0 && nextHeight > 0;
}

/** Key + geometry of a rendered virtual row, as needed for anchor capture. */
export interface AnchorRow {
  key: string;
  /** Top edge offset within the scroll content (px). */
  start: number;
  /** Bottom edge offset within the scroll content (px). */
  end: number;
}

/** A captured scroll anchor: which row to hold steady, and where it was. */
export interface ScrollAnchor {
  /** Stable key of the anchor row (from getItemKey). */
  key: string;
  /** Anchor row's top edge relative to the viewport top (start − scrollTop). */
  viewportOffset: number;
}

/**
 * Capture the row to re-anchor on before an items change applies, in
 * top-anchored mode. Live merges PREPEND rows (e.g. Observability's
 * `mergeCalls` sorts newest-first) and the absolutely-positioned virtual rows
 * defeat native scroll anchoring (`overflow-anchor`), so without compensation
 * the content under the cursor shifts down by the prepended height.
 *
 * Returns `null` when no re-anchoring should happen: tail-follow mode has its
 * own pinning contract, and at `scrollTop` 0 the user is reading the newest
 * rows, where prepends SHOULD push the view content down. Otherwise the
 * anchor is the first row still visible at the current scroll position
 * (overscan rows fully above the viewport are skipped), with its offset
 * relative to the viewport top so a partially scrolled-past row is restored
 * to the exact same position.
 */
export function captureScrollAnchor(
  followTail: boolean,
  scrollTop: number,
  rows: readonly AnchorRow[],
): ScrollAnchor | null {
  if (followTail || scrollTop <= 0 || rows.length === 0) return null;
  const anchor = rows.find((r) => r.end > scrollTop) ?? rows[rows.length - 1];
  return { key: anchor.key, viewportOffset: anchor.start - scrollTop };
}

/**
 * Index of the item whose key matches, or -1. Used to relocate the anchor
 * row after a merge changed the items array (prepends shift every index).
 */
export function findIndexByKey<T>(
  items: readonly T[],
  key: string,
  getKey: (item: T, index: number) => string,
): number {
  for (let i = 0; i < items.length; i++) {
    if (getKey(items[i], i) === key) return i;
  }
  return -1;
}

/**
 * Post-update scrollTop that puts the anchored row back at its captured
 * viewport offset. Returns `null` when no correction should be applied: the
 * anchor row is gone (`newStart` null — e.g. evicted by the live row cap) or
 * the current scroll position is already right (pure appends, no-op merges).
 * Clamped at 0; the caller's scrollToOffset clamps the far end.
 */
export function restoredScrollTop(
  anchor: ScrollAnchor,
  newStart: number | null,
  currentScrollTop: number,
): number | null {
  if (newStart === null) return null;
  const target = Math.max(0, newStart - anchor.viewportOffset);
  return target === currentScrollTop ? null : target;
}

export interface MountedRangeInput {
  /** Total number of items in the list. */
  count: number;
  /** Current scrollTop of the scroll container. */
  scrollOffset: number;
  /** Visible height (clientHeight) of the scroll container. */
  viewportHeight: number;
  /** Estimated row height in px (fixed-estimate model). */
  rowHeight: number;
  /** Rows rendered above/below the viewport. */
  overscan: number;
}

/**
 * Pure mirror of the virtualizer's windowing math under a fixed row-height
 * estimate: the inclusive index range of rows that should be mounted for a
 * given scroll position. Returns `null` when nothing should be mounted
 * (empty list or zero-height viewport, e.g. inside `display:none`). Used by
 * tests to assert that only the windowed subset of a large list is mounted.
 */
export function computeMountedRange(
  input: MountedRangeInput,
): { start: number; end: number } | null {
  const { count, scrollOffset, viewportHeight, rowHeight, overscan } = input;
  if (count <= 0 || viewportHeight <= 0 || rowHeight <= 0) return null;
  const maxIndex = count - 1;
  const clamp = (n: number) => Math.min(maxIndex, Math.max(0, n));
  const firstVisible = clamp(Math.floor(scrollOffset / rowHeight));
  const lastVisible = clamp(Math.ceil((scrollOffset + viewportHeight) / rowHeight) - 1);
  return {
    start: Math.max(0, firstVisible - overscan),
    end: Math.min(maxIndex, lastVisible + overscan),
  };
}
