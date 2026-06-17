import { describe, it, expect } from 'vitest';
import {
  averageDurationMs,
  callerLabel,
  canFocusLog,
  collectHitRects,
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
    logId: null,
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
  it('false when latest request has null logId', () => {
    expect(canFocusLog(makeGroup({ requests: [req({ logId: null })] }))).toBe(false);
  });
  it('true when latest request has a logId', () => {
    expect(canFocusLog(makeGroup({ requests: [req({ logId: '7' })] }))).toBe(true);
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

describe('callerLabel', () => {
  it('returns null when client is null/undefined', () => {
    expect(callerLabel(null)).toBeNull();
    expect(callerLabel(undefined)).toBeNull();
  });

  it('returns null when client has no name and no user_agent', () => {
    expect(callerLabel({})).toBeNull();
    expect(callerLabel({ origin: 'https://example.com' })).toBeNull();
  });

  it('prefers a non-empty client.label over the raw name / user_agent fallback', () => {
    expect(
      callerLabel({
        name: 'local-agent-mode-Endara Relay (via mcp-remote 0.1.37)',
        label: 'Claude Cowork',
      }),
    ).toBe('Claude Cowork');
    // trims whitespace and wins over user_agent too
    expect(callerLabel({ label: '  Claude Cowork  ', user_agent: 'claude-ai/0.1.0' })).toBe(
      'Claude Cowork',
    );
  });

  it('falls back to name / user_agent when label is absent or empty', () => {
    // empty / whitespace-only label behaves exactly as today
    expect(
      callerLabel({ label: '', name: 'local-agent-mode-Endara Relay (via mcp-remote 0.1.37)' }),
    ).toBe('local-agent-mode-Endara Relay (via mcp-remote 0.1.37)');
    expect(callerLabel({ label: '   ', user_agent: 'claude-ai/0.1.0' })).toBe('claude-ai');
    expect(callerLabel({ label: null, name: 'Cursor' })).toBe('Cursor');
  });

  it('prefers client.name (without version) when present', () => {
    expect(callerLabel({ name: 'Claude Desktop', version: '0.7.0' })).toBe('Claude Desktop');
  });

  it('trims whitespace from name', () => {
    expect(callerLabel({ name: '  Cursor  ' })).toBe('Cursor');
  });

  it('treats empty / whitespace-only name as missing and falls through to user_agent', () => {
    expect(callerLabel({ name: '', user_agent: 'claude-ai/0.1.0' })).toBe('claude-ai');
    expect(callerLabel({ name: '   ', user_agent: 'cursor/2.0.0' })).toBe('cursor');
  });

  it('derives the leading product token from a typical user_agent', () => {
    expect(callerLabel({ user_agent: 'claude-desktop/0.7.0' })).toBe('claude-desktop');
    expect(callerLabel({ user_agent: 'claude-ai/0.1.0 (extra)' })).toBe('claude-ai');
  });

  it('falls back to the full user_agent when no slash is present', () => {
    expect(callerLabel({ user_agent: 'SomeRawUA' })).toBe('SomeRawUA');
  });

  it('treats null name and null user_agent as missing', () => {
    expect(callerLabel({ name: null, user_agent: null })).toBeNull();
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

describe('collectHitRects', () => {
  const el = (x: number, y: number, width: number, height: number, logId?: string) => ({
    getBoundingClientRect: () => ({ x, y, width, height }),
    dataset: { logId },
  });

  it('maps elements to their bounding rects in order, tagging log_id', () => {
    expect(collectHitRects([el(20, 100, 340, 72, 'a'), el(20, 184, 340, 64, 'b')])).toEqual([
      { x: 20, y: 100, width: 340, height: 72, log_id: 'a' },
      { x: 20, y: 184, width: 340, height: 64, log_id: 'b' },
    ]);
  });

  it('defaults log_id to empty string when the slot has no data-log-id', () => {
    expect(collectHitRects([el(20, 100, 340, 72)])).toEqual([
      { x: 20, y: 100, width: 340, height: 72, log_id: '' },
    ]);
  });

  it('returns an empty list for no elements (poller idles)', () => {
    expect(collectHitRects([])).toEqual([]);
  });

  it('skips null/undefined entries', () => {
    expect(collectHitRects([null, el(1, 2, 3, 4, 'x'), undefined])).toEqual([
      { x: 1, y: 2, width: 3, height: 4, log_id: 'x' },
    ]);
  });

  it('drops zero-area rects (collapsed / not yet laid out elements)', () => {
    expect(
      collectHitRects([el(0, 0, 0, 50), el(0, 0, 50, 0), el(5, 5, 10, 10, 'k')]),
    ).toEqual([{ x: 5, y: 5, width: 10, height: 10, log_id: 'k' }]);
  });

  it('accepts any iterable (e.g. a NodeList-like)', () => {
    function* gen() {
      yield el(0, 0, 1, 1);
      yield el(2, 2, 1, 1);
    }
    expect(collectHitRects(gen())).toHaveLength(2);
  });
});
