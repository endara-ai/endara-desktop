// Tests for the action helpers extracted from `OverlayCard.svelte` and
// `OverlayApp.svelte`. These verify the exact Tauri commands the overlay
// invokes on user input, since the components themselves can't be mounted in
// the Node vitest env.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  cardClick,
  overlayPointerEnter,
  overlayPointerLeave,
} from './overlay-actions';
import type { ToolCallGroup, ToolCallRequest } from './toastStore';

function req(over: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return { requestId: 'r-1', ts: 'ts', status: 'inflight', jsonrpcId: null, ...over };
}

function g(over: Partial<ToolCallGroup> = {}): ToolCallGroup {
  return {
    id: 'gh|repo|list_issues',
    serverType: 'GitHub',
    serverName: 'repo',
    tool: 'list_issues',
    annotations: undefined,
    profile: null,
    inflight: 0,
    success: 0,
    error: 0,
    requests: [],
    lastUpdatedAt: 0,
    dismissAt: null,
    dismissTick: 0,
    ...over,
  };
}

describe('cardClick', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invokes focus_main_window_on_log when the latest request has a jsonrpcId', async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    await cardClick(
      g({
        requests: [
          req({ requestId: 'a', status: 'success', durationMs: 5, jsonrpcId: 'rpc-1' }),
          req({ requestId: 'b', status: 'success', durationMs: 7, jsonrpcId: 'rpc-7' }),
        ],
        success: 2,
      }),
    );

    expect(mockInvoke).toHaveBeenCalledWith('focus_main_window_on_log', {
      jsonrpcId: 'rpc-7',
    });
  });

  it('is a soft no-op when the latest request has no jsonrpcId', async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await cardClick(g({ requests: [req()] }));
    expect(mockInvoke).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('is a soft no-op when the group has no requests at all', async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    await cardClick(g());
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe('overlay pointer cursor toggles', () => {
  beforeEach(() => vi.clearAllMocks());

  it('overlayPointerEnter sets ignore_cursor_events(false)', async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);
    await overlayPointerEnter();
    expect(mockInvoke).toHaveBeenCalledWith('set_overlay_ignore_cursor_events', {
      ignore: false,
    });
  });

  it('overlayPointerLeave sets ignore_cursor_events(true)', async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);
    await overlayPointerLeave();
    expect(mockInvoke).toHaveBeenCalledWith('set_overlay_ignore_cursor_events', {
      ignore: true,
    });
  });

  it('swallows errors from invoke so a flaky window command never breaks the UI', async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockRejectedValue(new Error('boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(overlayPointerEnter()).resolves.toBeUndefined();
    await expect(overlayPointerLeave()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});
