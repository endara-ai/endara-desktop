import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { get } from 'svelte/store';
import { attachOverlayBridge, route } from './eventBridge';
import { createToastStore } from './toastStore';
import type {
  CompletedEvent,
  FailedEvent,
  StartedEvent,
  ToolCallEvent,
} from './types';

function makeStarted(overrides: Partial<StartedEvent> = {}): StartedEvent {
  return {
    kind: 'started',
    request_id: 'req-1',
    ts: '2026-05-27T04:36:29.710Z',
    endpoint: 'github',
    transport: 'stdio',
    server_type: 'github',
    server_name: 'github',
    profile: null,
    tool: 'list_issues',
    ...overrides,
  };
}

describe('eventBridge.route', () => {
  it('routes started → addStarted', () => {
    const store = createToastStore();
    const spy = vi.spyOn(store, 'addStarted');
    route(store, makeStarted());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('routes completed → settle', () => {
    const store = createToastStore();
    const settleSpy = vi.spyOn(store, 'settle');
    const ev: CompletedEvent = {
      kind: 'completed',
      request_id: 'req-1',
      ts: 'ts',
      duration_ms: 12,
      status: 'ok',
    };
    route(store, ev);
    expect(settleSpy).toHaveBeenCalledWith(ev);
  });

  it('routes failed → settle', () => {
    const store = createToastStore();
    const settleSpy = vi.spyOn(store, 'settle');
    const ev: FailedEvent = {
      kind: 'failed',
      request_id: 'req-1',
      ts: 'ts',
      duration_ms: 12,
      status: 'error',
      error_message: 'boom',
    };
    route(store, ev);
    expect(settleSpy).toHaveBeenCalledWith(ev);
  });

  it('drops unknown kinds without throwing', () => {
    const store = createToastStore();
    const addSpy = vi.spyOn(store, 'addStarted');
    const settleSpy = vi.spyOn(store, 'settle');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    route(store, { kind: 'rolled-up' } as unknown as ToolCallEvent);
    route(store, null);
    route(store, undefined);
    route(store, 'not-an-object' as unknown as ToolCallEvent);
    expect(addSpy).not.toHaveBeenCalled();
    expect(settleSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('attachOverlayBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers a tool-call-event listener and invokes subscribe_tool_call_events', async () => {
    const mockListen = vi.mocked(listen);
    const mockInvoke = vi.mocked(invoke);
    const unlistenFn = vi.fn();
    mockListen.mockResolvedValue(unlistenFn);
    mockInvoke.mockResolvedValue(undefined);

    const store = createToastStore();
    const disposer = await attachOverlayBridge(store);

    expect(mockListen).toHaveBeenCalledWith('tool-call-event', expect.any(Function));
    expect(mockInvoke).toHaveBeenCalledWith('subscribe_tool_call_events');
    expect(typeof disposer).toBe('function');
  });

  it('feeds started events from listen() into the store', async () => {
    const mockListen = vi.mocked(listen);
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);
    let capturedHandler: ((e: { payload: ToolCallEvent }) => void) | null = null;
    mockListen.mockImplementation(async (_name, handler) => {
      capturedHandler = handler as typeof capturedHandler;
      const unlisten: UnlistenFn = () => {};
      return unlisten;
    });

    const store = createToastStore();
    await attachOverlayBridge(store);

    capturedHandler!({ payload: makeStarted({ request_id: 'r-1' }) });
    capturedHandler!({
      payload: {
        kind: 'completed',
        request_id: 'r-1',
        ts: 'ts',
        duration_ms: 50,
        status: 'ok',
      } as CompletedEvent,
    });

    const groups = get(store);
    expect(groups).toHaveLength(1);
    expect(groups[0].inflight).toBe(0);
    expect(groups[0].success).toBe(1);
  });

  it('disposer unlistens and invokes unsubscribe_tool_call_events', async () => {
    const mockListen = vi.mocked(listen);
    const mockInvoke = vi.mocked(invoke);
    const unlistenFn = vi.fn();
    mockListen.mockResolvedValue(unlistenFn);
    mockInvoke.mockResolvedValue(undefined);

    const store = createToastStore();
    const disposer = await attachOverlayBridge(store);
    await disposer();

    expect(unlistenFn).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('unsubscribe_tool_call_events');
  });
});
