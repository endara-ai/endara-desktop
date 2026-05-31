import { describe, it, expect } from 'vitest';
import {
  averageDurationMs,
  canFocusLog,
  groupVisualState,
  hiddenGroupCount,
  hintsForAnnotations,
  isDestructive,
  isStacked,
  latestRequest,
  visibleGroups,
} from './overlay-helpers';
import type { ToolCallGroup, ToolCallRequest } from './toastStore';

function req(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    requestId: 'r-1',
    ts: 'ts',
    status: 'inflight',
    jsonrpcId: null,
    ...overrides,
  };
}

function makeGroup(over: Partial<ToolCallGroup> = {}): ToolCallGroup {
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

describe('groupVisualState', () => {
  it('returns "inflight" when any request is in flight', () => {
    expect(groupVisualState(makeGroup({ inflight: 1, success: 2 }))).toBe('inflight');
  });
  it('returns "fail" only when error>0 and success=0', () => {
    expect(groupVisualState(makeGroup({ error: 1, success: 0 }))).toBe('fail');
    expect(groupVisualState(makeGroup({ error: 1, success: 1 }))).toBe('success');
  });
  it('returns "success" otherwise', () => {
    expect(groupVisualState(makeGroup({ success: 3 }))).toBe('success');
    expect(groupVisualState(makeGroup())).toBe('success');
  });
});

describe('isStacked', () => {
  it('true only when more than one request', () => {
    expect(isStacked(makeGroup({ requests: [req()] }))).toBe(false);
    expect(isStacked(makeGroup({ requests: [req(), req({ requestId: 'r-2' })] }))).toBe(true);
  });
});

describe('hintsForAnnotations', () => {
  it('returns empty when annotations is undefined', () => {
    expect(hintsForAnnotations(undefined)).toEqual([]);
  });
  it('emits all four ordered correctly', () => {
    const hints = hintsForAnnotations({
      destructive: true,
      open_world: true,
      read_only: true,
      idempotent: true,
    });
    expect(hints.map((h) => h.kind)).toEqual([
      'readonly',
      'idempotent',
      'openworld',
      'destructive',
    ]);
    expect(hints.find((h) => h.kind === 'destructive')?.tone).toBe('danger');
    expect(hints.find((h) => h.kind === 'openworld')?.tone).toBe('warn');
    expect(hints.find((h) => h.kind === 'readonly')?.tone).toBe('muted');
  });
  it('skips falsy/absent annotations', () => {
    expect(hintsForAnnotations({ read_only: true }).map((h) => h.kind)).toEqual(['readonly']);
    expect(hintsForAnnotations({ destructive: false }).map((h) => h.kind)).toEqual([]);
  });
});

describe('averageDurationMs', () => {
  it('returns null when no requests resolved', () => {
    expect(averageDurationMs(makeGroup({ requests: [req()] }))).toBeNull();
  });
  it('rounds the mean of resolved durations', () => {
    const g = makeGroup({
      requests: [
        req({ requestId: 'a', status: 'success', durationMs: 100 }),
        req({ requestId: 'b', status: 'success', durationMs: 201 }),
      ],
    });
    expect(averageDurationMs(g)).toBe(151);
  });
});

describe('latestRequest', () => {
  it('returns the last pushed request', () => {
    const g = makeGroup({ requests: [req({ requestId: 'a' }), req({ requestId: 'b' })] });
    expect(latestRequest(g)?.requestId).toBe('b');
  });
  it('returns null for empty', () => {
    expect(latestRequest(makeGroup())).toBeNull();
  });
});

describe('canFocusLog', () => {
  it('false when latest request has null jsonrpcId', () => {
    expect(canFocusLog(makeGroup({ requests: [req({ jsonrpcId: null })] }))).toBe(false);
  });
  it('true when latest request has a jsonrpcId', () => {
    expect(canFocusLog(makeGroup({ requests: [req({ jsonrpcId: '7' })] }))).toBe(true);
  });
});

describe('isDestructive', () => {
  it('reflects annotations.destructive only when explicitly true', () => {
    expect(isDestructive(makeGroup({ annotations: { destructive: true } }))).toBe(true);
    expect(isDestructive(makeGroup({ annotations: { destructive: false } }))).toBe(false);
    expect(isDestructive(makeGroup({ annotations: {} }))).toBe(false);
    expect(isDestructive(makeGroup())).toBe(false);
  });
});

describe('visibleGroups / hiddenGroupCount', () => {
  const all = ['a', 'b', 'c', 'd', 'e'];
  it('returns everything when total <= maxVisible', () => {
    expect(visibleGroups(all, 10)).toEqual(all);
    expect(hiddenGroupCount(all.length, 10)).toBe(0);
  });
  it('keeps the newest `maxVisible` when overflowing', () => {
    expect(visibleGroups(all, 3)).toEqual(['c', 'd', 'e']);
    expect(hiddenGroupCount(all.length, 3)).toBe(2);
  });
  it('returns a copy', () => {
    const out = visibleGroups(all, 100);
    expect(out).not.toBe(all);
  });
});
