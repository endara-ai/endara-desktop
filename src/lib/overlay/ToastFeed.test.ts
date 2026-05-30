// Tests for the `ToastFeed.svelte` derivation pipeline. Vitest runs without
// jsdom, so we drive the same `visibleGroups` / `hiddenGroupCount` helpers
// the component invokes through `$derived` and assert the slicing rules
// (newest-at-bottom, "+N earlier" overflow row).
import { describe, it, expect } from 'vitest';
import { get } from 'svelte/store';
import {
  hiddenGroupCount,
  visibleGroups,
  type OverlayPosition,
} from './overlay-helpers';
import { createToastStore } from './toastStore';
import type { StartedEvent } from './types';

function startEv(over: Partial<StartedEvent> = {}): StartedEvent {
  return {
    kind: 'started',
    request_id: 'r',
    ts: 'ts',
    endpoint: 'github',
    transport: 'stdio',
    server_type: 'github',
    server_name: 'github',
    profile: null,
    tool: 'list_issues',
    ...over,
  };
}

describe('ToastFeed — visible window slicing', () => {
  it('shows every group when total <= maxVisible', () => {
    const store = createToastStore();
    for (let i = 0; i < 3; i++) {
      store.addStarted(startEv({ request_id: `r-${i}`, tool: `tool-${i}` }));
    }
    const groups = get(store);
    const visible = visibleGroups(groups, 7);
    expect(visible).toHaveLength(3);
    expect(hiddenGroupCount(groups.length, 7)).toBe(0);
  });

  it('keeps only the newest `maxVisible` groups when overflowing', () => {
    const store = createToastStore();
    for (let i = 0; i < 10; i++) {
      store.addStarted(startEv({ request_id: `r-${i}`, tool: `tool-${i}` }));
    }
    const groups = get(store);
    expect(groups).toHaveLength(10);

    const visible = visibleGroups(groups, 7);
    expect(visible).toHaveLength(7);
    expect(visible.map((g) => g.tool)).toEqual([
      'tool-3',
      'tool-4',
      'tool-5',
      'tool-6',
      'tool-7',
      'tool-8',
      'tool-9',
    ]);
    expect(hiddenGroupCount(groups.length, 7)).toBe(3);
  });

  it('renders the "+N earlier" marker only when there is overflow', () => {
    expect(hiddenGroupCount(5, 7)).toBe(0);
    expect(hiddenGroupCount(8, 7)).toBe(1);
    expect(hiddenGroupCount(20, 7)).toBe(13);
  });

  it('newest groups land at the end (bottom) of the visible slice', () => {
    const store = createToastStore();
    store.addStarted(startEv({ request_id: 'a', tool: 'first' }));
    store.addStarted(startEv({ request_id: 'b', tool: 'second' }));
    const visible = visibleGroups(get(store), 7);
    expect(visible[visible.length - 1].tool).toBe('second');
  });
});

describe('ToastFeed — position attribute', () => {
  it('exposes the documented `OverlayPosition` literal set', () => {
    // Lock the contract used by the route + future configuration. Adding a
    // value here must be paired with `overlay.css` selectors that anchor it.
    const positions: OverlayPosition[] = [
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
    ];
    expect(positions).toHaveLength(4);
  });

  it('forwards the `position` prop to each rendered OverlayCard', async () => {
    // The slide-in / slide-out direction is computed per-card from
    // `position` — the feed must pass the prop through so cards anchored
    // to the right slide off-screen to the right and vice versa.
    const src = (await import('./ToastFeed.svelte?raw')).default as string;
    expect(src).toMatch(/<OverlayCard[^>]*\{position\}/);
  });
});

// Slide-in / slide-out animation driven by overlay corner. The card
// wrapper rides Svelte's `in:fly` + a custom `out:slideCollapse`
// transition; the slide direction must mirror the position prop so
// right-anchored cards travel toward +x and left-anchored toward −x.
// Vitest runs in node (no jsdom), so we source-grep the component for
// the direction branch and the transition wiring.
describe('OverlayCard — position-driven slide direction', () => {
  it('right-anchored positions slide toward +x, left-anchored toward −x', () => {
    // Mirrors the `$derived` in OverlayCard.svelte: `position.endsWith('right')
    // ? 1 : -1`. Kept inline so the test exercises the exact predicate.
    const dirFor = (p: OverlayPosition) => (p.endsWith('right') ? 1 : -1);
    expect(dirFor('bottom-right')).toBe(1);
    expect(dirFor('top-right')).toBe(1);
    expect(dirFor('bottom-left')).toBe(-1);
    expect(dirFor('top-left')).toBe(-1);
  });

  it('OverlayCard.svelte derives slideDir from position.endsWith(\'right\')', async () => {
    const src = (await import('./OverlayCard.svelte?raw')).default as string;
    expect(src).toMatch(/slideDir = \$derived\(position\.endsWith\('right'\) \? 1 : -1\)/);
  });

  it('OverlayCard.svelte wires in:fly + out:slideCollapse on the wrapper', async () => {
    const src = (await import('./OverlayCard.svelte?raw')).default as string;
    expect(src).toMatch(/in:fly=\{\{ x: inX,/);
    expect(src).toMatch(/out:slideCollapse=\{\{ x: outX,/);
  });

  it('OverlayCard.svelte honours prefers-reduced-motion', async () => {
    const src = (await import('./OverlayCard.svelte?raw')).default as string;
    expect(src).toMatch(/prefers-reduced-motion: reduce/);
  });
});

// Regression for the unconditional top-edge fade: `.tf-feed-inner`
// previously applied `mask-image` always, so even a single card was
// faded into the desktop. We now gate the mask on a `data-overflow`
// attribute that mirrors `hidden > 0`. Because vitest runs without a
// DOM (env=node), we exercise (1) the logical predicate that drives
// the binding and (2) a source-level grep to guard against future
// edits removing the attribute or the gated CSS selector.
describe('ToastFeed — overflow-gated top-edge mask', () => {
  it('hiddenGroupCount is 0 (data-overflow="false") when total <= maxVisible', () => {
    expect(hiddenGroupCount(3, 7) > 0).toBe(false);
    expect(hiddenGroupCount(7, 7) > 0).toBe(false);
  });

  it('hiddenGroupCount is > 0 (data-overflow="true") when total > maxVisible', () => {
    expect(hiddenGroupCount(8, 7) > 0).toBe(true);
    expect(hiddenGroupCount(20, 7) > 0).toBe(true);
  });

  it('ToastFeed.svelte binds data-overflow to {hidden > 0} on .tf-feed-inner', async () => {
    // Vite's `?raw` query returns the source text as a string — works in
    // the node test env without needing jsdom or @types/node. This guards
    // against future edits silently dropping the attribute that gates the
    // CSS mask rule below (the CSS side is verified by the matching
    // selector check in this same suite).
    const src = (await import('./ToastFeed.svelte?raw')).default as string;
    expect(src).toMatch(/class="tf-feed-inner" data-overflow=\{hidden > 0\}/);
  });

  it('overlay.css scopes the top-edge mask on [data-overflow="true"]', async () => {
    // Vite's CSS pipeline intercepts `.css` imports (even with `?raw`)
    // and returns empty content in the vitest env, so we read the file
    // directly from disk. `@ts-expect-error` because `@types/node` is
    // not installed in this workspace; vitest runs in Node and resolves
    // these at runtime.
    // @ts-expect-error node builtin types not installed
    const { readFileSync } = await import('node:fs');
    // @ts-expect-error node builtin types not installed
    const { fileURLToPath } = await import('node:url');
    const cssPath = fileURLToPath(new URL('./overlay.css', import.meta.url));
    const src = readFileSync(cssPath, 'utf8') as string;
    // The bottom-anchored variant.
    expect(src).toMatch(/\.tf-feed-inner\[data-overflow='true'\]\s*\{/);
    // The top-anchored variant.
    expect(src).toMatch(
      /data-position='top-right'\] \.tf-feed-inner\[data-overflow='true'\]/,
    );
  });
});
