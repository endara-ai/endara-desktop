// Tests for the action helpers extracted from `OverlayCard.svelte` and
// `ToastFeed.svelte`. These verify the exact Tauri commands the overlay
// invokes, since the components themselves can't be mounted in the Node
// vitest env.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { cardClick, reportOverlayHitRects } from './overlay-actions';
import type { ToolCallGroup, ToolCallRequest } from './toastStore';

function req(over: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return { requestId: 'r-1', ts: 'ts', status: 'inflight', logId: null, ...over };
}

function g(over: Partial<ToolCallGroup> = {}): ToolCallGroup {
  return {
    id: 'gh|repo|list_issues',
    serverType: 'GitHub',
    serverName: 'repo',
    tool: 'list_issues',
    annotations: undefined,
    profile: null,
    client: null,
    inflight: 0,
    success: 0,
    error: 0,
    requests: [],
    lastUpdatedAt: 0,
    dismissAt: null,
    dismissDurationMs: null,
    dismissTick: 0,
    ...over,
  };
}

describe('cardClick', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invokes focus_main_window_on_log when the latest request has a logId', async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    await cardClick(
      g({
        requests: [
          req({ requestId: 'a', status: 'success', durationMs: 5, logId: 'rpc-1' }),
          req({ requestId: 'b', status: 'success', durationMs: 7, logId: 'rpc-7' }),
        ],
        success: 2,
      }),
    );

    expect(mockInvoke).toHaveBeenCalledWith('focus_main_window_on_log', {
      logId: 'rpc-7',
    });
  });

  it('is a soft no-op when the latest request has no logId', async () => {
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

describe('reportOverlayHitRects', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invokes set_overlay_hit_rects with the measured rects', async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);
    const rects = [{ x: 20, y: 100, width: 340, height: 72, log_id: 'req-1' }];
    await reportOverlayHitRects(rects);
    expect(mockInvoke).toHaveBeenCalledWith('set_overlay_hit_rects', { rects });
  });

  it('reports an empty list so the Rust poller can idle', async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);
    await reportOverlayHitRects([]);
    expect(mockInvoke).toHaveBeenCalledWith('set_overlay_hit_rects', { rects: [] });
  });

  it('swallows errors from invoke so a flaky window command never breaks the UI', async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockRejectedValue(new Error('boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(reportOverlayHitRects([])).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
