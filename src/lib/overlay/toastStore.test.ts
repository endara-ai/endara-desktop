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

  // Per-card (per-group) dismissal: each group owns its own
  // `setTimeout`. Arming and firing are scoped to a single group —
  // other cards' independent countdowns are untouched. No hover-pause
  // (see `OverlayApp.svelte` for the removed wiring); each card's
  // CSS keyframe and the JS timer both run to completion at the same
  // `dismissMs` offset.
  describe('per-group dismiss timer', () => {
    it('does NOT auto-dismiss a card while inflight (no timer until inflight reaches 0)', () => {
      const store = createToastStore({ dismissMs: 500 });
      store.addStarted(started({ request_id: 'req-1' }));
      vi.advanceTimersByTime(5000);
      expect(get(store)).toHaveLength(1);
      expect((get(store) as ToolCallGroup[])[0].inflight).toBe(1);
    });

    it('arms the group timer when inflight reaches 0 via settle, then removes that group', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.addStarted(started({ request_id: 'req-1' }));
      store.settle(completed('req-1', 'ok'));
      vi.advanceTimersByTime(999);
      expect(get(store)).toHaveLength(1);
      vi.advanceTimersByTime(2);
      expect(get(store)).toEqual([]);
    });

    it('settle sets dismissAt to Date.now() + dismissMs and bumps dismissTick', () => {
      const store = createToastStore({ dismissMs: 1500 });
      store.addStarted(started({ request_id: 'req-1' }));
      const before = (get(store) as ToolCallGroup[])[0];
      expect(before.dismissAt).toBeNull();
      expect(before.dismissTick).toBe(0);
      const t0 = Date.now();
      store.settle(completed('req-1', 'ok'));
      const after = (get(store) as ToolCallGroup[])[0];
      expect(after.dismissAt).not.toBeNull();
      expect(after.dismissAt as number).toBe(t0 + 1500);
      expect(after.dismissTick).toBe(1);
    });

    it('a new addStarted on the SAME group mid-countdown cancels that timer; the card stays', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.addStarted(started({ request_id: 'req-1' }));
      store.settle(completed('req-1', 'ok'));
      vi.advanceTimersByTime(500);
      store.addStarted(started({ request_id: 'req-2' }));
      // Timer cancelled; the card flipped back to in-flight.
      vi.advanceTimersByTime(10000);
      const groups = get(store) as ToolCallGroup[];
      expect(groups).toHaveLength(1);
      expect(groups[0].inflight).toBe(1);
    });

    it('cancellation by same-group addStarted resets dismissAt to null and bumps dismissTick', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.addStarted(started({ request_id: 'req-1' }));
      store.settle(completed('req-1', 'ok'));
      const armed = (get(store) as ToolCallGroup[])[0];
      const armedTick = armed.dismissTick;
      expect(armed.dismissAt).not.toBeNull();
      store.addStarted(started({ request_id: 'req-2' }));
      const canceled = (get(store) as ToolCallGroup[])[0];
      expect(canceled.dismissAt).toBeNull();
      expect(canceled.dismissTick).toBe(armedTick + 1);
    });

    it('re-settle after a cancel arms a fresh timer that fires from the new arm point', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.addStarted(started({ request_id: 'req-1' }));
      store.settle(completed('req-1', 'ok'));
      vi.advanceTimersByTime(500);
      store.addStarted(started({ request_id: 'req-2' }));
      vi.advanceTimersByTime(2000);
      // Still there: inflight=1 again, no timer.
      expect(get(store)).toHaveLength(1);
      store.settle(completed('req-2', 'ok'));
      vi.advanceTimersByTime(999);
      expect(get(store)).toHaveLength(1);
      vi.advanceTimersByTime(2);
      expect(get(store)).toEqual([]);
    });

    it('per-group timers are independent: firing one does not remove the others', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.addStarted(started({ request_id: 'a-1', tool: 'a' }));
      store.addStarted(started({ request_id: 'b-1', tool: 'b' }));
      store.settle(completed('a-1', 'ok'));
      vi.advanceTimersByTime(500);
      store.settle(completed('b-1', 'ok'));
      // a's timer fires at +1000 from a-settle (=500 from now);
      // b's timer fires at +1000 from b-settle (=1000 from now).
      vi.advanceTimersByTime(600);
      const groups = get(store) as ToolCallGroup[];
      expect(groups).toHaveLength(1);
      expect(groups[0].tool).toBe('b');
      vi.advanceTimersByTime(500);
      expect(get(store)).toEqual([]);
    });

    it('addStarted on a NEW group does not touch existing per-group timers', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.addStarted(started({ request_id: 'a-1', tool: 'a' }));
      store.settle(completed('a-1', 'ok'));
      vi.advanceTimersByTime(500);
      store.addStarted(started({ request_id: 'b-1', tool: 'b' }));
      // a's timer is still on schedule (fires 500ms from now), b is in-flight.
      vi.advanceTimersByTime(600);
      const groups = get(store) as ToolCallGroup[];
      expect(groups).toHaveLength(1);
      expect(groups[0].tool).toBe('b');
      expect(groups[0].inflight).toBe(1);
    });

    it('clear() cancels every per-group timer', () => {
      const store = createToastStore({ dismissMs: 500 });
      store.addStarted(started({ request_id: 'a-1', tool: 'a' }));
      store.addStarted(started({ request_id: 'b-1', tool: 'b' }));
      store.settle(completed('a-1', 'ok'));
      store.settle(completed('b-1', 'ok'));
      store.clear();
      expect(get(store)).toEqual([]);
      vi.advanceTimersByTime(5000);
      expect(get(store)).toEqual([]);
    });

    it('settle does not arm a timer while other in-flight requests remain on the same group', () => {
      const store = createToastStore({ dismissMs: 500 });
      store.addStarted(started({ request_id: 'req-1' }));
      store.addStarted(started({ request_id: 'req-2' }));
      store.settle(completed('req-1', 'ok'));
      vi.advanceTimersByTime(5000);
      const groups = get(store) as ToolCallGroup[];
      expect(groups).toHaveLength(1);
      expect(groups[0].inflight).toBe(1);
      expect(groups[0].dismissAt).toBeNull();
    });

    it('error settle arms the timer the same way as a success settle', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.addStarted(started({ request_id: 'req-1' }));
      store.settle(failed('req-1', 'boom'));
      vi.advanceTimersByTime(999);
      expect(get(store)).toHaveLength(1);
      vi.advanceTimersByTime(2);
      expect(get(store)).toEqual([]);
    });
  });

  // Per-card progress bar surface on `ToolCallGroup`. The card reads
  // `dismissTick` to key its `{#key}` re-mount of the CSS keyframe;
  // `dismissAt` is exposed for diagnostics. A new started event on
  // the same group while it's counting down cancels the timer, bumps
  // `dismissTick`, and resets `dismissAt` to null.
  describe('per-group progress bar state', () => {
    it('new group starts with dismissAt=null and dismissTick=0', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.addStarted(started({ request_id: 'req-1' }));
      const g = (get(store) as ToolCallGroup[])[0];
      expect(g.dismissAt).toBeNull();
      expect(g.dismissTick).toBe(0);
    });

    it('settle while inflight remains > 0 does NOT arm: dismissAt stays null, dismissTick unchanged', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.addStarted(started({ request_id: 'req-1' }));
      store.addStarted(started({ request_id: 'req-2' }));
      store.settle(completed('req-1', 'ok'));
      const g = (get(store) as ToolCallGroup[])[0];
      expect(g.dismissAt).toBeNull();
      expect(g.dismissTick).toBe(0);
    });

    it('settle that drives inflight to 0 arms: dismissAt set, dismissTick bumped', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.addStarted(started({ request_id: 'req-1' }));
      store.settle(completed('req-1', 'ok'));
      const g = (get(store) as ToolCallGroup[])[0];
      expect(g.dismissAt).not.toBeNull();
      expect(g.dismissTick).toBe(1);
    });

    it('setOpts() updates the dismissMs captured on the NEXT arm (dismissAt reflects it)', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.setOpts({ dismissMs: 4500 });
      store.addStarted(started({ request_id: 'req-1' }));
      const t0 = Date.now();
      store.settle(completed('req-1', 'ok'));
      const g = (get(store) as ToolCallGroup[])[0];
      expect(g.dismissAt as number).toBe(t0 + 4500);
    });

    it('re-arm after cancel + re-settle bumps dismissTick again (monotonic per group)', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.addStarted(started({ request_id: 'req-1' }));
      store.settle(completed('req-1', 'ok'));
      expect((get(store) as ToolCallGroup[])[0].dismissTick).toBe(1);
      store.addStarted(started({ request_id: 'req-2' })); // cancel → +1
      expect((get(store) as ToolCallGroup[])[0].dismissTick).toBe(2);
      store.settle(completed('req-2', 'ok')); // re-arm → +1
      expect((get(store) as ToolCallGroup[])[0].dismissTick).toBe(3);
    });

    it('different groups maintain independent dismissTick counters', () => {
      const store = createToastStore({ dismissMs: 1000 });
      store.addStarted(started({ request_id: 'a-1', tool: 'a' }));
      store.addStarted(started({ request_id: 'b-1', tool: 'b' }));
      store.settle(completed('a-1', 'ok'));
      const groups = get(store) as ToolCallGroup[];
      const a = groups.find((g) => g.tool === 'a')!;
      const b = groups.find((g) => g.tool === 'b')!;
      expect(a.dismissTick).toBe(1);
      expect(b.dismissTick).toBe(0);
    });
  });
});
