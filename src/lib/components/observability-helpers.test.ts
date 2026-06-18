import { describe, it, expect, vi } from 'vitest';

import type { CallRecordDto, AggregateBucketDto } from '$lib/types';
import {
  buildCallsFilter,
  formatDuration,
  formatBytes,
  formatTime,
  callStatus,
  globalBuckets,
  bucketSeries,
  sparklinePoints,
  combinedDomain,
  nearestIndex,
  debounce,
  isTerminalEvent,
  mergeCalls,
  distinctValues,
  prettyJson,
  parseJsonTree,
  type CallsFilterUi,
} from './observability-helpers';

const baseUi: CallsFilterUi = {
  serverName: '',
  tool: '',
  status: 'all',
  windowMinutes: 0,
  requestUid: '',
  limit: 100,
  offset: 0,
};

function call(p: Partial<CallRecordDto>): CallRecordDto {
  return {
    id: 1,
    requestUid: 'u1',
    endpoint: 'e',
    serverName: 'github',
    tool: 'get_file',
    tsStart: 1000,
    success: true,
    streamed: false,
    ...p,
  };
}

describe('buildCallsFilter', () => {
  it('omits empty server/tool and leaves success unset for "all"', () => {
    expect(buildCallsFilter(baseUi)).toEqual({ limit: 100, offset: 0 });
  });

  it('maps trimmed server/tool and the success tri-state', () => {
    expect(buildCallsFilter({ ...baseUi, serverName: ' github ', tool: ' foo ', status: 'errors' })).toEqual({
      limit: 100,
      offset: 0,
      server_name: 'github',
      tool: 'foo',
      success: false,
    });
    expect(buildCallsFilter({ ...baseUi, status: 'success' }).success).toBe(true);
  });

  it('derives a since bound from the window using injected now', () => {
    const f = buildCallsFilter({ ...baseUi, windowMinutes: 5 }, 1_000_000);
    expect(f.since).toBe(1_000_000 - 5 * 60_000);
  });

  it('maps a trimmed requestUid to request_uid and drops it when empty', () => {
    expect(buildCallsFilter({ ...baseUi, requestUid: ' abc-123 ' }).request_uid).toBe('abc-123');
    expect(buildCallsFilter({ ...baseUi, requestUid: '   ' }).request_uid).toBeUndefined();
    expect(buildCallsFilter(baseUi).request_uid).toBeUndefined();
  });
});

describe('formatters', () => {
  it('formatDuration', () => {
    expect(formatDuration(312)).toBe('312 ms');
    expect(formatDuration(1500)).toBe('1.50 s');
    expect(formatDuration(undefined)).toBe('—');
  });

  it('formatBytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(null)).toBe('—');
  });

  it('formatTime guards bad input', () => {
    expect(formatTime(undefined)).toBe('—');
    expect(formatTime(NaN)).toBe('—');
    expect(typeof formatTime(1000)).toBe('string');
  });
});

describe('callStatus', () => {
  it('labels success and error with message', () => {
    expect(callStatus(call({ success: true }))).toEqual({ ok: true, label: 'success' });
    expect(callStatus(call({ success: false, errorMessage: 'boom' }))).toEqual({
      ok: false,
      label: 'error',
    });
    expect(callStatus(call({ success: false }))).toEqual({ ok: false, label: 'error' });
  });
});

describe('aggregate buckets', () => {
  const buckets: AggregateBucketDto[] = [
    { server: 'github', bucketStart: 2, count: 1, errorCount: 0, p50Ms: 5, p95Ms: 9 },
    { bucketStart: 2, count: 3, errorCount: 1, p50Ms: 7, p95Ms: 20 },
    { bucketStart: 1, count: 2, errorCount: 0, p50Ms: 4, p95Ms: 6 },
  ];

  it('globalBuckets keeps only server-less buckets, sorted by start', () => {
    const g = globalBuckets(buckets);
    expect(g.map((b) => b.bucketStart)).toEqual([1, 2]);
  });

  it('bucketSeries extracts a field', () => {
    expect(bucketSeries(globalBuckets(buckets), 'count')).toEqual([2, 3]);
    expect(bucketSeries(globalBuckets(buckets), 'errorCount')).toEqual([0, 1]);
  });
});

describe('sparklinePoints', () => {
  it('returns empty string for no data', () => {
    expect(sparklinePoints([], { width: 100, height: 20 })).toBe('');
  });

  it('centres a single value', () => {
    expect(sparklinePoints([5], { width: 100, height: 20, padding: 1 })).toBe('1,10.00 99.00,10.00');
  });

  it('maps min to bottom and max to top', () => {
    const pts = sparklinePoints([0, 10], { width: 10, height: 10, padding: 0 }).split(' ');
    expect(pts[0]).toBe('0.00,10.00');
    expect(pts[1]).toBe('10.00,0.00');
  });

  it('honours a shared domain so series are comparable', () => {
    // With a shared [0,10] domain, the value 5 sits at the vertical midpoint
    // (y = 5 of a height-10 box) instead of being stretched to its own range.
    const pts = sparklinePoints([0, 5], { width: 10, height: 10, padding: 0, min: 0, max: 10 }).split(
      ' ',
    );
    expect(pts[0]).toBe('0.00,10.00');
    expect(pts[1]).toBe('10.00,5.00');
  });
});

describe('combinedDomain', () => {
  it('spans the min/max across all series', () => {
    expect(combinedDomain([[1, 9], [4, 20]])).toEqual({ min: 1, max: 20 });
  });

  it('returns a zero domain for empty input', () => {
    expect(combinedDomain([])).toEqual({ min: 0, max: 0 });
    expect(combinedDomain([[], []])).toEqual({ min: 0, max: 0 });
  });
});

describe('nearestIndex', () => {
  it('maps the hover ratio to the nearest bucket index', () => {
    expect(nearestIndex(0, 5)).toBe(0);
    expect(nearestIndex(1, 5)).toBe(4);
    expect(nearestIndex(0.5, 5)).toBe(2);
    // Rounds to the nearest: 0.6 * 4 = 2.4 → 2; 0.7 * 4 = 2.8 → 3.
    expect(nearestIndex(0.6, 5)).toBe(2);
    expect(nearestIndex(0.7, 5)).toBe(3);
  });

  it('clamps out-of-range ratios into [0, length - 1]', () => {
    expect(nearestIndex(-0.5, 5)).toBe(0);
    expect(nearestIndex(1.5, 5)).toBe(4);
  });

  it('returns 0 for empty, single-point, or non-finite input', () => {
    expect(nearestIndex(0.5, 0)).toBe(0);
    expect(nearestIndex(0.5, 1)).toBe(0);
    expect(nearestIndex(Number.NaN, 5)).toBe(0);
  });
});

describe('debounce', () => {
  it('collapses a burst into one trailing call', () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = debounce(fn, 250);
      d();
      d();
      d();
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(250);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel() prevents a pending call', () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = debounce(fn, 250);
      d();
      d.cancel();
      vi.advanceTimersByTime(500);
      expect(fn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('live event merging', () => {
  it('isTerminalEvent only for completed/failed', () => {
    expect(isTerminalEvent({ kind: 'completed' })).toBe(true);
    expect(isTerminalEvent({ kind: 'failed' })).toBe(true);
    expect(isTerminalEvent({ kind: 'started' })).toBe(false);
    expect(isTerminalEvent(null)).toBe(false);
  });

  it('mergeCalls dedupes by requestUid (incoming wins) newest-first', () => {
    const existing = [call({ requestUid: 'a', tsStart: 1000, tool: 'old' })];
    const incoming = [
      call({ requestUid: 'a', tsStart: 1000, tool: 'new' }),
      call({ requestUid: 'b', tsStart: 3000 }),
    ];
    const merged = mergeCalls(existing, incoming);
    expect(merged.map((c) => c.requestUid)).toEqual(['b', 'a']);
    expect(merged[1].tool).toBe('new');
  });

  it('distinctValues returns sorted unique field values', () => {
    const calls = [call({ serverName: 'b' }), call({ serverName: 'a' }), call({ serverName: 'a' })];
    expect(distinctValues(calls, 'serverName')).toEqual(['a', 'b']);
  });
});

describe('prettyJson', () => {
  it('pretty-prints valid JSON', () => {
    expect(prettyJson('{"a":1}').text).toBe('{\n  "a": 1\n}');
  });

  it('falls back to raw text and flags truncation', () => {
    expect(prettyJson('not json').text).toBe('not json');
    const big = prettyJson('x'.repeat(50), 10);
    expect(big.truncated).toBe(true);
    expect(big.text).toHaveLength(10);
  });

  it('skips parsing when raw far exceeds maxChars (returns truncated raw)', () => {
    const huge = JSON.stringify({ a: 'y'.repeat(900_000) });
    const out = prettyJson(huge); // default 200k cap; 900k > 200k * 4
    expect(out.truncated).toBe(true);
    expect(out.text).toHaveLength(200_000);
    // Not pretty-printed (a parsed object would start with '{\n  "a"').
    expect(out.text.startsWith('{"a":')).toBe(true);
  });

  it('skips parsing past the absolute ceiling even with an unbounded cap (copy path)', () => {
    const huge = JSON.stringify({ a: 'z'.repeat(2_000_000) });
    const out = prettyJson(huge, Number.MAX_SAFE_INTEGER);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(1_000_000);
    expect(out.text.startsWith('{"a":')).toBe(true);
  });
});

describe('parseJsonTree', () => {
  it('parses JSON objects and arrays for the tree viewer', () => {
    expect(parseJsonTree('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonTree('[1,2]')).toEqual({ ok: true, value: [1, 2] });
  });

  it('falls back for non-JSON, empty, primitives, and oversized text', () => {
    expect(parseJsonTree('not json')).toEqual({ ok: false });
    expect(parseJsonTree('')).toEqual({ ok: false });
    expect(parseJsonTree('null')).toEqual({ ok: false });
    expect(parseJsonTree('42')).toEqual({ ok: false });
    expect(parseJsonTree('"a string"')).toEqual({ ok: false });
    expect(parseJsonTree('{"a":1}', 3)).toEqual({ ok: false });
  });
});
