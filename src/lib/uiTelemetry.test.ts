import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  createRateLimiter,
  createRoundTripStats,
  createMgmtTelemetry,
  createDriftTracker,
  createErrorForwarder,
  formatErrorForLog,
  formatHealthLine,
  shouldEmitHealth,
  readHeapFigures,
  HEALTH_LOG_INTERVAL_MS,
  type UiLogFn,
} from './uiTelemetry';
import { guardInFlight } from './inFlightGuard';

describe('createRateLimiter', () => {
  it('allows up to the limit within a window, then refuses', () => {
    const limiter = createRateLimiter(3, 60_000);
    expect(limiter.allow(0)).toBe(true);
    expect(limiter.allow(1)).toBe(true);
    expect(limiter.allow(2)).toBe(true);
    expect(limiter.allow(3)).toBe(false);
    expect(limiter.allow(59_999)).toBe(false);
  });

  it('resets once the window has elapsed', () => {
    const limiter = createRateLimiter(1, 60_000);
    expect(limiter.allow(0)).toBe(true);
    expect(limiter.allow(1)).toBe(false);
    expect(limiter.allow(60_000)).toBe(true);
    expect(limiter.allow(60_001)).toBe(false);
  });
});

describe('createErrorForwarder', () => {
  it('forwards errors at ERROR level and drops beyond the limit', () => {
    const log = vi.fn<UiLogFn>();
    const fwd = createErrorForwarder({ log, limiter: createRateLimiter(2, 60_000) });
    expect(fwd.onError('boom', 'Error: boom\n  at a.ts:1\n  at b.ts:2', 0)).toBe(true);
    expect(fwd.onRejection(new TypeError('bad'), 1)).toBe(true);
    expect(fwd.onError('dropped', undefined, 2)).toBe(false);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenNthCalledWith(1, 'error', 'window.onerror: boom | Error: boom | at a.ts:1 | at b.ts:2');
    expect(log.mock.calls[1][0]).toBe('error');
    expect(log.mock.calls[1][1]).toContain('unhandledrejection: TypeError: bad');
  });

  it('formats non-Error rejection reasons', () => {
    const log = vi.fn<UiLogFn>();
    const fwd = createErrorForwarder({ log });
    fwd.onRejection('plain string');
    fwd.onRejection({ code: 42 });
    expect(log).toHaveBeenNthCalledWith(1, 'error', 'unhandledrejection: plain string');
    expect(log).toHaveBeenNthCalledWith(2, 'error', 'unhandledrejection: {"code":42}');
  });
});

describe('formatErrorForLog', () => {
  it('keeps at most five non-empty stack lines on a single line', () => {
    const stack = Array.from({ length: 8 }, (_, i) => `  at frame${i}`).join('\n\n');
    const line = formatErrorForLog('k', 'm', stack);
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toBe('k: m | at frame0 | at frame1 | at frame2 | at frame3 | at frame4');
  });
});

describe('createRoundTripStats', () => {
  it('reports count, p50 and max', () => {
    const stats = createRoundTripStats();
    [50, 10, 30, 500, 20].forEach((ms) => stats.record(ms));
    expect(stats.snapshot()).toEqual({ count: 5, p50Ms: 30, maxMs: 500 });
    stats.reset();
    expect(stats.snapshot()).toEqual({ count: 0, p50Ms: 0, maxMs: 0 });
  });

  it('caps retained samples', () => {
    const stats = createRoundTripStats(3);
    [1, 2, 3, 4].forEach((ms) => stats.record(ms));
    expect(stats.snapshot()).toEqual({ count: 3, p50Ms: 3, maxMs: 4 });
  });
});

describe('createMgmtTelemetry', () => {
  it('tracks in-flight count independently of the round-trip window', () => {
    const t = createMgmtTelemetry();
    t.begin();
    t.begin();
    expect(t.inFlight).toBe(2);
    t.end(100);
    expect(t.snapshot()).toEqual({ inFlight: 1, count: 1, p50Ms: 100, maxMs: 100 });
    t.resetWindow();
    expect(t.snapshot()).toEqual({ inFlight: 1, count: 0, p50Ms: 0, maxMs: 0 });
    t.end(5);
    t.end(5);
    expect(t.inFlight).toBe(0);
  });
});

describe('createDriftTracker', () => {
  it('measures timer lateness and wall-vs-monotonic drift', () => {
    const d = createDriftTracker(1000);
    d.tick(10_000, 0);
    d.tick(11_000, 1000);
    d.tick(12_250, 2250);
    d.tick(18_250, 3250);
    const s = d.snapshot();
    expect(s.ticks).toBe(3);
    expect(s.lastLatenessMs).toBe(0);
    expect(s.maxLatenessMs).toBe(250);
    expect(s.wallVsPerfDriftMs).toBe(5000);
    d.resetWindow();
    expect(d.snapshot()).toEqual({ ticks: 0, lastLatenessMs: 0, maxLatenessMs: 0, wallVsPerfDriftMs: 0 });
  });
});

describe('health line', () => {
  it('shouldEmitHealth gates on the 5 minute interval', () => {
    expect(shouldEmitHealth(Number.NEGATIVE_INFINITY, 0)).toBe(true);
    expect(shouldEmitHealth(0, HEALTH_LOG_INTERVAL_MS - 1)).toBe(false);
    expect(shouldEmitHealth(0, HEALTH_LOG_INTERVAL_MS)).toBe(true);
  });

  it('formatHealthLine renders every field as key=value', () => {
    const line = formatHealthLine({
      seq: 7,
      heartbeatLatencyMs: 12.4,
      visibility: 'visible',
      drift: { ticks: 300, lastLatenessMs: 3, maxLatenessMs: 40, wallVsPerfDriftMs: -1 },
      heap: { usedMB: 50, totalMB: 80, limitMB: 4096 },
      mgmt: { inFlight: 1, count: 20, p50Ms: 15.6, maxMs: 900 },
    });
    expect(line).toBe(
      'health seq=7 hb_latency=12ms visibility=visible timer_ticks=300 timer_lateness=3ms/max=40ms ' +
        'wall_vs_perf_drift=-1ms heap_mb=50/80/limit=4096 mgmt_inflight=1 mgmt_rtt_n=20 mgmt_rtt_p50=16ms mgmt_rtt_max=900ms',
    );
  });

  it('readHeapFigures returns null when performance.memory is absent', () => {
    expect(readHeapFigures({})).toBeNull();
    expect(readHeapFigures(undefined)).toBeNull();
    expect(
      readHeapFigures({ memory: { usedJSHeapSize: 2 * 1_048_576, totalJSHeapSize: 3 * 1_048_576, jsHeapSizeLimit: 4 * 1_048_576 } }),
    ).toEqual({ usedMB: 2, totalMB: 3, limitMB: 4 });
  });
});

describe('guardInFlight', () => {
  it('skips calls while a previous run is still pending, then allows again', async () => {
    let resolveFirst!: () => void;
    const fn = vi.fn(() => new Promise<string>((r) => { resolveFirst = () => r('done'); }));
    const guarded = guardInFlight(fn);

    const first = guarded();
    expect(guarded.inFlight).toBe(true);
    await expect(guarded()).resolves.toBeUndefined();
    await expect(guarded()).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(guarded.skipped).toBe(2);

    resolveFirst();
    await expect(first).resolves.toBe('done');
    expect(guarded.inFlight).toBe(false);

    const second = guarded();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(guarded.inFlight).toBe(true);
    resolveFirst();
    await expect(second).resolves.toBe('done');
    expect(guarded.inFlight).toBe(false);
  });

  it('releases the guard when the wrapped task rejects', async () => {
    const guarded = guardInFlight(async () => {
      throw new Error('nope');
    });
    await expect(guarded()).rejects.toThrow('nope');
    expect(guarded.inFlight).toBe(false);
  });
});

describe('mgmtRequest slow-request warning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('logs one WARN via ui_log when an invoke is still pending after 20 s', async () => {
    vi.useFakeTimers();
    const { getStatus, SLOW_MGMT_REQUEST_MS } = await import('./api');
    let resolveInvoke!: (v: unknown) => void;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'mgmt_api_request') return new Promise((r) => { resolveInvoke = r; });
      return Promise.resolve(undefined);
    });

    const pending = getStatus();
    await vi.advanceTimersByTimeAsync(SLOW_MGMT_REQUEST_MS - 1);
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'ui_log')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    const warnCalls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'ui_log');
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0][1]).toMatchObject({ level: 'warn' });
    expect((warnCalls[0][1] as { message: string }).message).toContain('mgmt_api_request GET /api/status still pending after 20000ms');

    resolveInvoke({ status: 200, body: JSON.stringify({ status: 'ok' }) });
    await expect(pending).resolves.toEqual({ status: 'ok' });
    await vi.advanceTimersByTimeAsync(SLOW_MGMT_REQUEST_MS);
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'ui_log')).toHaveLength(1);
    vi.useRealTimers();
  });

  it('does not warn when the request completes promptly', async () => {
    vi.useFakeTimers();
    const { getStatus, SLOW_MGMT_REQUEST_MS } = await import('./api');
    vi.mocked(invoke).mockResolvedValue({ status: 200, body: JSON.stringify({ status: 'ok' }) });
    await getStatus();
    await vi.advanceTimersByTimeAsync(SLOW_MGMT_REQUEST_MS + 1);
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'ui_log')).toHaveLength(0);
    vi.useRealTimers();
  });
});
