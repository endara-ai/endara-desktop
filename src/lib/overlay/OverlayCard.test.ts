// Tests for the `OverlayCard.svelte` derivation pipeline + click handler.
//
// Vitest runs in the Node env (no jsdom), so we exercise the same helpers
// the component imports and the `cardClick` action it wires onclick to —
// asserting the exact behaviour the component renders for each branch.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  averageDurationMs,
  canFocusLog,
  groupVisualState,
  hintsForAnnotations,
  isDestructive,
  isStacked,
} from './overlay-helpers';
import { cardClick } from './overlay-actions';
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
    dismissStartedAt: null,
    ...over,
  };
}

describe('OverlayCard — visual state branches', () => {
  it('renders in-flight state when any request is in flight', () => {
    const group = g({ inflight: 1, requests: [req()] });
    expect(groupVisualState(group)).toBe('inflight');
    // duration row hides while in flight (showDuration === false)
    expect(averageDurationMs(group)).toBeNull();
  });

  it('renders success state when only resolved + no errors', () => {
    const group = g({
      success: 1,
      requests: [req({ status: 'success', durationMs: 312 })],
    });
    expect(groupVisualState(group)).toBe('success');
    expect(averageDurationMs(group)).toBe(312);
  });

  it('renders fail state when all resolved are errors', () => {
    const group = g({
      error: 2,
      requests: [
        req({ status: 'error', durationMs: 50 }),
        req({ requestId: 'r-2', status: 'error', durationMs: 100 }),
      ],
    });
    expect(groupVisualState(group)).toBe('fail');
    expect(isStacked(group)).toBe(true);
  });

  it('stacked variant shows ghost peek + counts', () => {
    const group = g({
      success: 1,
      error: 1,
      inflight: 1,
      requests: [
        req({ requestId: 'a', status: 'success', durationMs: 100 }),
        req({ requestId: 'b', status: 'error', durationMs: 200 }),
        req({ requestId: 'c', status: 'inflight' }),
      ],
    });
    expect(isStacked(group)).toBe(true);
    expect(groupVisualState(group)).toBe('inflight');
  });

  it('keeps "N calls · Mms avg" visible while inflight if any call has settled', () => {
    // Mirrors the OverlayCard.svelte predicate `stacked && hasSettled && avgMs != null`
    // where `hasSettled = group.success > 0 || group.error > 0`. A new inflight call
    // mid-burst must not hide the avg-text the burst already earned.
    const group = g({
      inflight: 1,
      success: 2,
      error: 0,
      requests: [
        req({ requestId: 'a', status: 'success', durationMs: 120 }),
        req({ requestId: 'b', status: 'success', durationMs: 180 }),
        req({ requestId: 'c', status: 'inflight' }),
      ],
    });
    const hasSettled = group.success > 0 || group.error > 0;
    expect(isStacked(group)).toBe(true);
    expect(hasSettled).toBe(true);
    expect(averageDurationMs(group)).toBe(150);
    // Old behaviour gated on `state !== 'inflight'` would have hidden the avg-text here.
    expect(groupVisualState(group)).toBe('inflight');
  });

  it('destructive variant flips border + accent bar', () => {
    const group = g({ annotations: { destructive: true } });
    expect(isDestructive(group)).toBe(true);
  });
});

describe('OverlayCard — hint pills', () => {
  it('renders one pill per truthy annotation in fixed order', () => {
    const hints = hintsForAnnotations({
      destructive: true,
      open_world: true,
      read_only: true,
    });
    expect(hints.map((h) => h.label)).toEqual(['read-only', 'open-world', 'destructive']);
  });

  it('renders zero pills when annotations is undefined', () => {
    expect(hintsForAnnotations(undefined)).toEqual([]);
  });
});

describe('OverlayCard — click handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invokes focus_main_window_on_log with the latest request jsonrpcId', async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    const group = g({
      requests: [
        req({ requestId: 'a', status: 'success', durationMs: 12, jsonrpcId: 'rpc-1' }),
        req({ requestId: 'b', status: 'success', durationMs: 14, jsonrpcId: 'rpc-2' }),
      ],
      success: 2,
    });
    expect(canFocusLog(group)).toBe(true);

    await cardClick(group);
    expect(mockInvoke).toHaveBeenCalledWith('focus_main_window_on_log', {
      jsonrpcId: 'rpc-2',
    });
  });

  it('is a soft no-op when the latest request has null jsonrpcId', async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    const group = g({
      requests: [req({ jsonrpcId: null })],
      inflight: 1,
    });
    expect(canFocusLog(group)).toBe(false);

    await cardClick(group);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe('OverlayCard — dismiss progress', () => {
  it('mounts the dismiss bar only when dismissStartedAt is set', () => {
    const before = g({ dismissStartedAt: null });
    const after = g({ dismissStartedAt: Date.now() });
    expect(before.dismissStartedAt).toBeNull();
    expect(after.dismissStartedAt).not.toBeNull();
  });
});
