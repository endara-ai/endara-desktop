import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { createToastStore, type ToolCallGroup } from './toastStore';
import type { CompletedEvent, FailedEvent, StartedEvent } from './types';

function started(overrides: Partial<StartedEvent> = {}): StartedEvent {
  return {
    kind: 'started',
    request_id: 'req-1',
    ts: '2026-05-27T04:36:29.710Z',
    endpoint: 'github',
    transport: 'stdio',
    server_type: 'github',
    server_name: 'github',
    profile: 'default',
    tool: 'list_issues',
    annotations: { read_only: true },
    ...overrides,
  };
}

function completed(request_id: string, status: 'ok' | 'error' = 'ok'): CompletedEvent {
  return {
    kind: 'completed',
    request_id,
    ts: '2026-05-27T04:36:30.022Z',
    duration_ms: 312,
    status,
  };
}

function failed(request_id: string, error_message = 'boom'): FailedEvent {
  return {
    kind: 'failed',
    request_id,
    ts: '2026-05-27T04:36:30.022Z',
    duration_ms: 99,
    status: 'error',
    error_message,
  };
}

describe('toastStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('addStarted creates a new group with inflight=1 and pushes to end', () => {
    const store = createToastStore();
    store.addStarted(started());
    const groups = get(store) as ToolCallGroup[];
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('github|github|list_issues');
    expect(groups[0].inflight).toBe(1);
    expect(groups[0].success).toBe(0);
    expect(groups[0].error).toBe(0);
    expect(groups[0].requests).toHaveLength(1);
    expect(groups[0].requests[0].requestId).toBe('req-1');
    expect(groups[0].requests[0].status).toBe('inflight');
    expect(groups[0].annotations).toEqual({ read_only: true });
    expect(groups[0].profile).toBe('default');
  });

  it('addStarted with same key increments inflight in the existing group', () => {
    const store = createToastStore();
    store.addStarted(started({ request_id: 'req-1' }));
    store.addStarted(started({ request_id: 'req-2' }));
    const groups = get(store) as ToolCallGroup[];
    expect(groups).toHaveLength(1);
    expect(groups[0].inflight).toBe(2);
    expect(groups[0].requests).toHaveLength(2);
  });

  it('settle (ok) marks the request success and decrements inflight', () => {
    const store = createToastStore();
    store.addStarted(started({ request_id: 'req-1' }));
    store.addStarted(started({ request_id: 'req-2' }));
    store.settle(completed('req-1', 'ok'));
    const groups = get(store) as ToolCallGroup[];
    expect(groups[0].inflight).toBe(1);
    expect(groups[0].success).toBe(1);
    expect(groups[0].error).toBe(0);
    expect(groups[0].requests[0].status).toBe('success');
    expect(groups[0].requests[0].durationMs).toBe(312);
  });

  it('settle (error via completed status="error") routes to the error counter', () => {
    const store = createToastStore();
    store.addStarted(started({ request_id: 'req-1' }));
    store.settle(completed('req-1', 'error'));
    const groups = get(store) as ToolCallGroup[];
    expect(groups[0].error).toBe(1);
    expect(groups[0].success).toBe(0);
    expect(groups[0].requests[0].status).toBe('error');
  });

  it('settle (failed) carries the error_message onto the request', () => {
    const store = createToastStore();
    store.addStarted(started({ request_id: 'req-1' }));
    store.settle(failed('req-1', 'connection reset'));
    const groups = get(store) as ToolCallGroup[];
    expect(groups[0].error).toBe(1);
    expect(groups[0].requests[0].status).toBe('error');
    expect(groups[0].requests[0].errorMessage).toBe('connection reset');
    expect(groups[0].requests[0].durationMs).toBe(99);
  });

  it('settle for unknown request_id is a no-op (out-of-order delivery)', () => {
    const store = createToastStore();
    store.addStarted(started({ request_id: 'req-1' }));
    store.settle(completed('does-not-exist', 'ok'));
    const groups = get(store) as ToolCallGroup[];
    expect(groups[0].inflight).toBe(1);
    expect(groups[0].success).toBe(0);
  });

  it('clear() empties the store and cancels any pending dismiss', () => {
    const store = createToastStore({ dismissMs: 500 });
    store.addStarted(started({ request_id: 'req-1' }));
    store.settle(completed('req-1', 'ok'));
    store.clear();
    expect(get(store)).toEqual([]);
    vi.advanceTimersByTime(2000);
    expect(get(store)).toEqual([]);
  });

  it('default opts: dismissMs=6000, maxVisible=4, showProfile=true', () => {
    const store = createToastStore();
    expect(store.getOpts()).toEqual({
      dismissMs: 6000,
      maxVisible: 4,
      showProfile: true,
    });
  });

  it('setOpts() shallow-merges and affects future dismiss timers', () => {
    const store = createToastStore({ dismissMs: 100 });
    store.setOpts({ dismissMs: 1500 });
    expect(store.getOpts().dismissMs).toBe(1500);
    expect(store.getOpts().maxVisible).toBe(4);
    store.addStarted(started({ request_id: 'req-1' }));
    store.settle(completed('req-1', 'ok'));
    vi.advanceTimersByTime(1400);
    expect(get(store)).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(get(store)).toHaveLength(0);
  });

  it('grouping treats null server_type/server_name as empty-string components', () => {
    const store = createToastStore();
    store.addStarted(
      started({ request_id: 'req-1', server_type: null, server_name: null, tool: 't' }),
    );
    store.addStarted(
      started({ request_id: 'req-2', server_type: undefined, server_name: undefined, tool: 't' }),
    );
    const groups = get(store) as ToolCallGroup[];
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('||t');
    expect(groups[0].inflight).toBe(2);
  });

  it('persists jsonrpcId from started event onto the request', () => {
    const store = createToastStore();
    store.addStarted(started({ request_id: 'req-1', jsonrpc_id: '42' }));
    const groups = get(store) as ToolCallGroup[];
    expect(groups[0].requests[0].jsonrpcId).toBe('42');
  });

  it('defaults jsonrpcId to null when the relay event omits it', () => {
    const store = createToastStore();
    store.addStarted(started({ request_id: 'req-1' }));
    const groups = get(store) as ToolCallGroup[];
    expect(groups[0].requests[0].jsonrpcId).toBeNull();
  });

  it('settle backfills jsonrpcId when the started event lacked one', () => {
    const store = createToastStore();
    store.addStarted(started({ request_id: 'req-1' }));
    store.settle({ ...completed('req-1'), jsonrpc_id: '7' });
    const groups = get(store) as ToolCallGroup[];
    expect(groups[0].requests[0].jsonrpcId).toBe('7');
  });

  it('settle never downgrades a known jsonrpcId back to null', () => {
    const store = createToastStore();
    store.addStarted(started({ request_id: 'req-1', jsonrpc_id: '42' }));
    store.settle(completed('req-1'));
    const groups = get(store) as ToolCallGroup[];
    expect(groups[0].requests[0].jsonrpcId).toBe('42');
  });

  // Regression for the Phase 4 grouping bug: `OverlayCard` is keyed by
  // `group.id`, so its `group` prop keeps the same identity across
  // updates and Svelte 5 never re-runs the `$derived` expressions that
  // read inner fields. The store MUST replace each mutated group with a
  // new object reference so the card sees a fresh prop on every change.
  describe('copy-on-write identity (regression: OverlayCard re-render)', () => {
    it('addStarted on an existing key produces a fresh ToolCallGroup reference', () => {
      const store = createToastStore();
      store.addStarted(started({ request_id: 'req-1' }));
      const first = (get(store) as ToolCallGroup[])[0];
      store.addStarted(started({ request_id: 'req-2' }));
      const second = (get(store) as ToolCallGroup[])[0];
      expect(second).not.toBe(first);
      expect(second.requests).not.toBe(first.requests);
      expect(second.inflight).toBe(2);
    });

    it('settle produces a fresh ToolCallGroup AND a fresh ToolCallRequest reference', () => {
      const store = createToastStore();
      store.addStarted(started({ request_id: 'req-1' }));
      const beforeGroup = (get(store) as ToolCallGroup[])[0];
      const beforeReq = beforeGroup.requests[0];
      store.settle(completed('req-1', 'ok'));
      const afterGroup = (get(store) as ToolCallGroup[])[0];
      const afterReq = afterGroup.requests[0];
      expect(afterGroup).not.toBe(beforeGroup);
      expect(afterReq).not.toBe(beforeReq);
      expect(afterReq.status).toBe('success');
    });
  });

  // Feed-level idle dismissal: a single timer ticks `dismissMs` from the
  // most recent push/update. When it fires, the whole feed is cleared at
  // once and the `ToastFeed` component plays a single group-level
  // slide-out (see `ToastFeed.svelte`). Replaces the previous per-card
  // dismiss model.
  describe('feed-level idle dismiss', () => {
    it('arms on addStarted and clears the entire feed after dismissMs of idle', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.addStarted(started({ request_id: 'req-1' }));
      // Inflight is fine; the timer is idle-based, not state-based.
      vi.advanceTimersByTime(999);
      expect(get(store)).toHaveLength(1);
      vi.advanceTimersByTime(2);
      expect(get(store)).toEqual([]);
    });

    it('settle resets the timer so the idle window starts from the latest update', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.addStarted(started({ request_id: 'req-1' }));
      vi.advanceTimersByTime(800);
      store.settle(completed('req-1', 'ok'));
      // Without reset the feed would clear in another 200ms. With reset
      // it survives until 1000ms after `settle`.
      vi.advanceTimersByTime(999);
      expect(get(store)).toHaveLength(1);
      vi.advanceTimersByTime(2);
      expect(get(store)).toEqual([]);
    });

    it('a second addStarted resets the timer (idle clock starts over)', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.addStarted(started({ request_id: 'a-1', tool: 'a' }));
      vi.advanceTimersByTime(900);
      store.addStarted(started({ request_id: 'b-1', tool: 'b' }));
      vi.advanceTimersByTime(900);
      expect(get(store)).toHaveLength(2);
      vi.advanceTimersByTime(200);
      expect(get(store)).toEqual([]);
    });

    it('clears every group at once (single group-level slide-out, no per-group survival)', () => {
      const store = createToastStore({ dismissMs: 500 });
      store.addStarted(started({ request_id: 'a-1', tool: 'a' }));
      store.addStarted(started({ request_id: 'b-1', tool: 'b' }));
      store.settle(completed('a-1', 'ok'));
      store.settle(completed('b-1', 'ok'));
      vi.advanceTimersByTime(499);
      expect(get(store)).toHaveLength(2);
      vi.advanceTimersByTime(2);
      expect(get(store)).toEqual([]);
    });

    it('pauseDismiss() freezes the idle clock while the cursor is over the overlay', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.addStarted(started({ request_id: 'req-1' }));
      vi.advanceTimersByTime(500);
      store.pauseDismiss();
      // Even way past dismissMs, the feed must still be on screen.
      vi.advanceTimersByTime(5000);
      expect(get(store)).toHaveLength(1);
    });

    it('resumeDismiss() re-arms the timer with a fresh full window', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.addStarted(started({ request_id: 'req-1' }));
      store.pauseDismiss();
      vi.advanceTimersByTime(5000);
      store.resumeDismiss();
      vi.advanceTimersByTime(999);
      expect(get(store)).toHaveLength(1);
      vi.advanceTimersByTime(2);
      expect(get(store)).toEqual([]);
    });

    it('resumeDismiss() while empty does not arm a phantom timer', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.pauseDismiss();
      store.resumeDismiss();
      vi.advanceTimersByTime(5000);
      expect(get(store)).toEqual([]);
    });

    it('addStarted while paused does NOT start the timer (hover-pause sticks)', () => {
      const store = createToastStore({ dismissMs: 500 });
      store.pauseDismiss();
      store.addStarted(started({ request_id: 'req-1' }));
      vi.advanceTimersByTime(5000);
      expect(get(store)).toHaveLength(1);
      store.resumeDismiss();
      vi.advanceTimersByTime(499);
      expect(get(store)).toHaveLength(1);
      vi.advanceTimersByTime(2);
      expect(get(store)).toEqual([]);
    });
  });
});
