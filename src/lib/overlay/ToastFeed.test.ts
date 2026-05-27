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
});
