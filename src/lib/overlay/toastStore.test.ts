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

  it('schedules dismiss when the last in-flight request settles', () => {
    const store = createToastStore({ dismissMs: 1000 });
    store.addStarted(started({ request_id: 'req-1' }));
    store.settle(completed('req-1', 'ok'));
    let groups = get(store) as ToolCallGroup[];
    expect(groups[0].dismissStartedAt).not.toBeNull();
    vi.advanceTimersByTime(999);
    groups = get(store) as ToolCallGroup[];
    expect(groups).toHaveLength(1);
    vi.advanceTimersByTime(2);
    groups = get(store) as ToolCallGroup[];
    expect(groups).toHaveLength(0);
  });

  it('does NOT schedule dismiss while inflight > 0', () => {
    const store = createToastStore({ dismissMs: 500 });
    store.addStarted(started({ request_id: 'req-1' }));
    store.addStarted(started({ request_id: 'req-2' }));
    store.settle(completed('req-1', 'ok'));
    const groups = get(store) as ToolCallGroup[];
    expect(groups[0].inflight).toBe(1);
    expect(groups[0].dismissStartedAt).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(get(store)).toHaveLength(1);
  });

  it('a repeat addStarted cancels the running dismiss timer and moves the group to end', () => {
    const store = createToastStore({ dismissMs: 500 });
    // Group A
    store.addStarted(
      started({ request_id: 'a-1', tool: 'tool_a', server_name: 'a' }),
    );
    store.settle(completed('a-1', 'ok'));
    // Group B (newer)
    store.addStarted(
      started({ request_id: 'b-1', tool: 'tool_b', server_name: 'b' }),
    );
    // A's dismiss timer is running; repeat for A cancels it and moves A to end.
    store.addStarted(
      started({ request_id: 'a-2', tool: 'tool_a', server_name: 'a' }),
    );
    let groups = get(store) as ToolCallGroup[];
    expect(groups.map((g) => g.tool)).toEqual(['tool_b', 'tool_a']);
    const aGroup = groups.find((g) => g.tool === 'tool_a')!;
    expect(aGroup.dismissStartedAt).toBeNull();
    expect(aGroup.inflight).toBe(1);
    // Advancing past the original dismissMs must NOT remove A — the timer
    // was cancelled and A is now in-flight again.
    vi.advanceTimersByTime(1000);
    groups = get(store) as ToolCallGroup[];
    expect(groups.find((g) => g.tool === 'tool_a')).toBeDefined();
  });

  it('clear() cancels every dismiss timer and empties the store', () => {
    const store = createToastStore({ dismissMs: 500 });
    store.addStarted(started({ request_id: 'req-1' }));
    store.settle(completed('req-1', 'ok'));
    // Mid-flight a dismiss timer is running.
    store.clear();
    expect(get(store)).toEqual([]);
    // Advancing past the original dismissMs must NOT throw or re-publish.
    vi.advanceTimersByTime(2000);
    expect(get(store)).toEqual([]);
  });

  it('default opts: dismissMs=2000, maxVisible=4, showProfile=true', () => {
    const store = createToastStore();
    expect(store.getOpts()).toEqual({
      dismissMs: 2000,
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

  it('scheduleDismiss / cancelDismiss can be driven directly', () => {
    const store = createToastStore({ dismissMs: 300 });
    store.addStarted(started({ request_id: 'req-1' }));
    store.scheduleDismiss('github|github|list_issues');
    expect((get(store) as ToolCallGroup[])[0].dismissStartedAt).not.toBeNull();
    store.cancelDismiss('github|github|list_issues');
    expect((get(store) as ToolCallGroup[])[0].dismissStartedAt).toBeNull();
    vi.advanceTimersByTime(500);
    expect(get(store)).toHaveLength(1);
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
});
