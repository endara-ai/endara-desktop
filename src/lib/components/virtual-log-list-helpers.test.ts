import { describe, it, expect } from 'vitest';

import {
  DEFAULT_OVERSCAN,
  becameVisible,
  computeMountedRange,
  isPinnedToBottom,
  itemKeyAt,
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
  it('follows the tail while pinned and items exist', () => {
    expect(shouldStickToBottom(true, 10)).toBe(true);
  });

  it('does not follow when the user scrolled away', () => {
    expect(shouldStickToBottom(false, 10)).toBe(false);
  });

  it('does nothing after Clear (empty list)', () => {
    expect(shouldStickToBottom(true, 0)).toBe(false);
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
