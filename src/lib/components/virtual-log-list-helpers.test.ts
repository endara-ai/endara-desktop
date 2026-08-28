import { describe, it, expect } from 'vitest';

import {
  DEFAULT_OVERSCAN,
  becameVisible,
  captureScrollAnchor,
  computeMountedRange,
  findIndexByKey,
  isPinnedToBottom,
  itemKeyAt,
  restoredScrollTop,
  shouldRepinOnUnhide,
  shouldReportInitialPinned,
  shouldStickToBottom,
} from './virtual-log-list-helpers';

// Pure glue logic behind `VirtualLogList.svelte`. The desktop test env is
// Node (vitest.config.ts), so — like every other component in this folder —
// we exercise the extracted helpers rather than mounting the Svelte
// component.

describe('itemKeyAt (stable keys)', () => {
  const getKey = (item: { raw: string }) => item.raw;

  it('delegates to the consumer getKey for in-range indexes', () => {
    const items = [{ raw: 'a' }, { raw: 'b' }];
    expect(itemKeyAt(items, 0, getKey)).toBe('a');
    expect(itemKeyAt(items, 1, getKey)).toBe('b');
  });

  it('keeps the same key for the same item across appends and replacement', () => {
    const items = [{ raw: 'line-1' }, { raw: 'line-2' }];
    const before = itemKeyAt(items, 1, getKey);
    const grown = [...items, { raw: 'line-3' }];
    expect(itemKeyAt(grown, 1, getKey)).toBe(before);
    const replaced = [{ raw: 'line-1' }, { raw: 'line-2' }, { raw: 'line-3' }];
    expect(itemKeyAt(replaced, 1, getKey)).toBe(before);
  });

  it('returns a sentinel for transiently out-of-range indexes (shrink/Clear)', () => {
    const items = [{ raw: 'only' }];
    expect(itemKeyAt(items, 5, getKey)).toBe('__vll-missing-5');
    expect(itemKeyAt([] as { raw: string }[], 0, getKey)).toBe('__vll-missing-0');
  });
});

describe('isPinnedToBottom (isAtBottom semantics)', () => {
  it('is pinned at the exact bottom', () => {
    expect(isPinnedToBottom(600, 1000, 400)).toBe(true);
  });

  it('is pinned within the 40px threshold', () => {
    expect(isPinnedToBottom(561, 1000, 400)).toBe(true);
  });

  it('is not pinned when scrolled away from the bottom', () => {
    expect(isPinnedToBottom(500, 1000, 400)).toBe(false);
  });

  it('is pinned when content is smaller than the viewport', () => {
    expect(isPinnedToBottom(0, 100, 400)).toBe(true);
  });
});

describe('shouldStickToBottom (bottom-pinned behavior)', () => {
  it('follows the tail while pinned, items exist and the viewport is visible', () => {
    expect(shouldStickToBottom(true, 10, 400)).toBe(true);
  });

  it('does not follow when the user scrolled away', () => {
    expect(shouldStickToBottom(false, 10, 400)).toBe(false);
  });

  it('does nothing after Clear (empty list)', () => {
    expect(shouldStickToBottom(true, 0, 400)).toBe(false);
  });

  it('skips the dead scroll work while hidden (0-height viewport)', () => {
    expect(shouldStickToBottom(true, 10, 0)).toBe(false);
  });

  it('defaults to tail-follow mode when followTail is omitted', () => {
    expect(shouldStickToBottom(true, 10, 400)).toBe(shouldStickToBottom(true, 10, 400, true));
  });

  it('never follows the tail in top-anchored mode (followTail = false)', () => {
    expect(shouldStickToBottom(true, 10, 400, false)).toBe(false);
    expect(shouldStickToBottom(false, 10, 400, false)).toBe(false);
  });
});

describe('shouldReportInitialPinned (parent resync after {#if} remounts)', () => {
  it('reports once the scroll element is bound', () => {
    expect(shouldReportInitialPinned(true, false)).toBe(true);
  });

  it('does not report before the scroll element is bound', () => {
    expect(shouldReportInitialPinned(false, false)).toBe(false);
  });

  it('reports only once per instance', () => {
    expect(shouldReportInitialPinned(true, true)).toBe(false);
  });

  it('defaults to tail-follow mode when followTail is omitted', () => {
    expect(shouldReportInitialPinned(true, false)).toBe(shouldReportInitialPinned(true, false, true));
  });

  it('never reports in top-anchored mode (followTail = false)', () => {
    expect(shouldReportInitialPinned(true, false, false)).toBe(false);
  });
});

describe('shouldRepinOnUnhide (visibility ResizeObserver re-pin)', () => {
  it('re-pins while pinned in tail-follow mode', () => {
    expect(shouldRepinOnUnhide(true)).toBe(true);
    expect(shouldRepinOnUnhide(true, true)).toBe(true);
  });

  it('does not re-pin when the user scrolled away', () => {
    expect(shouldRepinOnUnhide(false)).toBe(false);
    expect(shouldRepinOnUnhide(false, true)).toBe(false);
  });

  it('never re-pins in top-anchored mode (followTail = false)', () => {
    expect(shouldRepinOnUnhide(true, false)).toBe(false);
    expect(shouldRepinOnUnhide(false, false)).toBe(false);
  });
});

describe('captureScrollAnchor (top-anchored prepend compensation)', () => {
  // Three contiguous 30px rows starting at 60px — as produced by
  // getVirtualItems() for a mid-list scroll position with overscan.
  const rows = [
    { key: 'c', start: 60, end: 90 },
    { key: 'd', start: 90, end: 120 },
    { key: 'e', start: 120, end: 150 },
  ];

  it('never captures in tail-follow mode (followTail = true)', () => {
    expect(captureScrollAnchor(true, 100, rows)).toBeNull();
  });

  it('never captures when pinned to the top (scrollTop = 0)', () => {
    expect(captureScrollAnchor(false, 0, rows)).toBeNull();
  });

  it('never captures with no rendered rows', () => {
    expect(captureScrollAnchor(false, 100, [])).toBeNull();
  });

  it('anchors on the first row still visible, skipping rows fully above', () => {
    // scrollTop 95: row c (end 90) is fully above, d (90–120) straddles.
    expect(captureScrollAnchor(false, 95, rows)).toEqual({ key: 'd', viewportOffset: -5 });
  });

  it('captures a zero offset when a row edge aligns with the viewport top', () => {
    expect(captureScrollAnchor(false, 90, rows)).toEqual({ key: 'd', viewportOffset: 0 });
  });

  it('falls back to the last row when every row is above the scroll position', () => {
    expect(captureScrollAnchor(false, 500, rows)).toEqual({ key: 'e', viewportOffset: -380 });
  });
});

describe('findIndexByKey (anchor relocation after a merge)', () => {
  const getKey = (item: { uid: string }) => item.uid;

  it('finds the shifted index after a prepend', () => {
    const merged = [{ uid: 'new-1' }, { uid: 'new-2' }, { uid: 'a' }, { uid: 'b' }];
    expect(findIndexByKey(merged, 'a', getKey)).toBe(2);
  });

  it('returns -1 when the anchor row was evicted (live cap)', () => {
    expect(findIndexByKey([{ uid: 'x' }], 'gone', getKey)).toBe(-1);
    expect(findIndexByKey([] as { uid: string }[], 'gone', getKey)).toBe(-1);
  });
});

describe('restoredScrollTop (offset restore)', () => {
  const anchor = { key: 'd', viewportOffset: -5 };

  it('puts the anchor row back at the captured viewport offset', () => {
    // Two 30px rows prepended: the anchor row moved from start 90 to 150.
    // scrollTop must become 150 − (−5) = 155 to keep it 5px above the top.
    expect(restoredScrollTop(anchor, 150, 95)).toBe(155);
  });

  it('is a no-op when nothing moved (append-only merge)', () => {
    expect(restoredScrollTop(anchor, 90, 95)).toBeNull();
  });

  it('is a no-op when the anchor row is gone (evicted by the live cap)', () => {
    expect(restoredScrollTop(anchor, null, 95)).toBeNull();
  });

  it('clamps at the top when the anchor moved above the captured offset', () => {
    // Anchor sat 10px below the viewport top but now starts at 5px: the raw
    // target (5 − 10 = −5) clamps to 0.
    expect(restoredScrollTop({ key: 'd', viewportOffset: 10 }, 5, 95)).toBe(0);
    // Already at 0 and the target clamps to 0 → no-op.
    expect(restoredScrollTop({ key: 'd', viewportOffset: 10 }, 5, 0)).toBeNull();
  });
});

describe('becameVisible (display:none support)', () => {
  it('detects the 0 → non-zero transition', () => {
    expect(becameVisible(0, 400)).toBe(true);
  });

  it('ignores ordinary resizes and hides', () => {
    expect(becameVisible(400, 500)).toBe(false);
    expect(becameVisible(400, 0)).toBe(false);
    expect(becameVisible(0, 0)).toBe(false);
  });
});

describe('computeMountedRange (windowed subset)', () => {
  const base = { rowHeight: 20, overscan: DEFAULT_OVERSCAN };

  it('mounts nothing for an empty list', () => {
    expect(
      computeMountedRange({ ...base, count: 0, scrollOffset: 0, viewportHeight: 400 }),
    ).toBeNull();
  });

  it('mounts nothing while the viewport has zero height (hidden ancestor)', () => {
    expect(
      computeMountedRange({ ...base, count: 1000, scrollOffset: 0, viewportHeight: 0 }),
    ).toBeNull();
  });

  it('mounts every row when the list is smaller than the viewport', () => {
    const range = computeMountedRange({
      ...base,
      count: 5,
      scrollOffset: 0,
      viewportHeight: 400,
    });
    expect(range).toEqual({ start: 0, end: 4 });
  });

  it('mounts only the windowed subset of a large list', () => {
    const count = 10_000;
    const range = computeMountedRange({
      ...base,
      count,
      scrollOffset: 100_000,
      viewportHeight: 400,
    });
    // 20 visible rows (400 / 20) + overscan on both sides — nowhere near 10k.
    expect(range).toEqual({ start: 4990, end: 5029 });
    const mounted = range!.end - range!.start + 1;
    expect(mounted).toBe(20 + 2 * DEFAULT_OVERSCAN);
    expect(mounted).toBeLessThan(count / 100);
  });

  it('clamps the window at the top of the list', () => {
    const range = computeMountedRange({
      ...base,
      count: 10_000,
      scrollOffset: 0,
      viewportHeight: 400,
    });
    expect(range).toEqual({ start: 0, end: 29 });
  });

  it('clamps the window at the bottom when pinned to the end', () => {
    const count = 10_000;
    const totalHeight = count * base.rowHeight;
    const viewportHeight = 400;
    const range = computeMountedRange({
      ...base,
      count,
      scrollOffset: totalHeight - viewportHeight,
      viewportHeight,
    });
    expect(range!.end).toBe(count - 1);
    expect(range!.start).toBe(count - 1 - (20 - 1) - DEFAULT_OVERSCAN);
  });
});
