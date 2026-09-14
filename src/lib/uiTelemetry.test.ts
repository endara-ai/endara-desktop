import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  createRoundTripStats,
  createMgmtTelemetry,
  createDriftTracker,
  createErrorForwarder,
  formatErrorForLog,
  formatHealthLine,
  shouldEmitHealth,
  readHeapFigures,
  installErrorForwarding,
  startUiTelemetry,
  HEALTH_LOG_INTERVAL_MS,
  ERROR_LOG_LIMIT_PER_MINUTE,
  ERROR_LOG_WINDOW_MS,
  type UiLogFn,
} from './uiTelemetry';
import { guardInFlight } from './inFlightGuard';

describe('createErrorForwarder', () => {
  it('forwards errors at ERROR level, then warns once and drops beyond the limit', () => {
    const log = vi.fn<UiLogFn>();
    const fwd = createErrorForwarder({ log, limit: 2, windowMs: 60_000 });
    expect(fwd.onError('boom', 'Error: boom\n  at a.ts:1\n  at b.ts:2', 0)).toBe(true);
    expect(fwd.onRejection(new TypeError('bad'), 1)).toBe(true);
    expect(fwd.onError('dropped', undefined, 2)).toBe(false);
    expect(fwd.onError('dropped too', undefined, 3)).toBe(false);
    expect(log).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenNthCalledWith(1, 'error', 'window.onerror: boom | Error: boom | at a.ts:1 | at b.ts:2');
    expect(log.mock.calls[1][0]).toBe('error');
    expect(log.mock.calls[1][1]).toContain('unhandledrejection: TypeError: bad');
    expect(log).toHaveBeenNthCalledWith(3, 'warn', 'error forwarding: limit of 2 per 60s reached; dropping further errors');
  });

  it('drops identical messages within the window and counts them in the summary', () => {
    const log = vi.fn<UiLogFn>();
    const fwd = createErrorForwarder({ log, limit: 2, windowMs: 60_000 });
    expect(fwd.onError('same', 'stack A', 0)).toBe(true);
    expect(fwd.onError('same', 'stack B', 1)).toBe(false);
    expect(fwd.onRejection(new Error('same'), 2)).toBe(true);
    expect(fwd.onRejection(new Error('same'), 3)).toBe(false);
    expect(fwd.onError('other', undefined, 4)).toBe(false);
    expect(log).toHaveBeenCalledTimes(3);
    expect(log.mock.calls[2][0]).toBe('warn');

    // Next window: one summary line for the previous window, then forwarding resumes.
    expect(fwd.onError('same', undefined, 60_000)).toBe(true);
    expect(log).toHaveBeenCalledTimes(5);
    expect(log).toHaveBeenNthCalledWith(
      4,
      'warn',
      'error forwarding: dropped 3 error(s) in the last 60s (1 over the limit of 2, 2 duplicate(s))',
    );
    expect(log).toHaveBeenNthCalledWith(5, 'error', 'window.onerror: same');
  });

  it('emits no summary when nothing was dropped', () => {
    const log = vi.fn<UiLogFn>();
    const fwd = createErrorForwarder({ log, limit: 5, windowMs: 60_000 });
    fwd.onError('a', undefined, 0);
    fwd.onError('b', undefined, 60_000);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.every(([level]) => level === 'error')).toBe(true);
  });

  it('defaults to the per-minute limit', () => {
    const log = vi.fn<UiLogFn>();
    const fwd = createErrorForwarder({ log });
    for (let i = 0; i < ERROR_LOG_LIMIT_PER_MINUTE; i++) expect(fwd.onError(`e${i}`, undefined, i)).toBe(true);
    expect(fwd.onError('over', undefined, ERROR_LOG_LIMIT_PER_MINUTE)).toBe(false);
    expect(fwd.onError('over', undefined, ERROR_LOG_WINDOW_MS)).toBe(true);
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs one WARN via ui_log and console.warn when an invoke is still pending after 20 s', async () => {
    vi.useFakeTimers();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getStatus, SLOW_MGMT_REQUEST_MS } = await import('./api');
    let resolveInvoke!: (v: unknown) => void;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === 'mgmt_api_request') return new Promise((r) => { resolveInvoke = r; });
      return Promise.resolve(undefined);
    });

    const pending = getStatus();
    await vi.advanceTimersByTimeAsync(SLOW_MGMT_REQUEST_MS - 1);
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'ui_log')).toHaveLength(0);
    expect(consoleWarn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const warnCalls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'ui_log');
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0][1]).toMatchObject({ level: 'warn' });
    const message = (warnCalls[0][1] as { message: string }).message;
    expect(message).toContain('mgmt_api_request GET /api/status still pending after 20000ms');
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledWith(`[ui] ${message}`);

    resolveInvoke({ status: 200, body: JSON.stringify({ status: 'ok' }) });
    await expect(pending).resolves.toEqual({ status: 'ok' });
    await vi.advanceTimersByTimeAsync(SLOW_MGMT_REQUEST_MS);
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'ui_log')).toHaveLength(1);
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('does not warn when the request completes promptly', async () => {
    vi.useFakeTimers();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getStatus, SLOW_MGMT_REQUEST_MS } = await import('./api');
    vi.mocked(invoke).mockResolvedValue({ status: 200, body: JSON.stringify({ status: 'ok' }) });
    await getStatus();
    await vi.advanceTimersByTimeAsync(SLOW_MGMT_REQUEST_MS + 1);
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'ui_log')).toHaveLength(0);
    expect(consoleWarn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

/** Minimal `Window`-like event target for the node test environment. */
function createFakeWindow() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const target = {
    addEventListener: vi.fn((type: string, fn: (e: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: (e: unknown) => void) => {
      listeners.get(type)?.delete(fn);
    }),
    dispatch(type: string, event: unknown) {
      listeners.get(type)?.forEach((fn) => fn(event));
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
  return target;
}

const uiLogCalls = () =>
  vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'ui_log').map(([, args]) => args as { level: string; message: string });

describe('installErrorForwarding', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it('forwards window error and unhandledrejection events through ui_log at ERROR', async () => {
    const win = createFakeWindow();
    const remove = installErrorForwarding(win as unknown as Window);
    expect(win.listenerCount('error')).toBe(1);
    expect(win.listenerCount('unhandledrejection')).toBe(1);

    const error = new Error('kaboom');
    error.stack = 'Error: kaboom\n  at x.ts:1';
    win.dispatch('error', { message: 'kaboom', error });
    win.dispatch('unhandledrejection', { reason: new RangeError('out of range') });
    await Promise.resolve();

    const calls = uiLogCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ level: 'error', message: 'window.onerror: kaboom | Error: kaboom | at x.ts:1' });
    expect(calls[1].level).toBe('error');
    expect(calls[1].message).toContain('unhandledrejection: RangeError: out of range');

    remove();
    expect(win.listenerCount('error')).toBe(0);
    expect(win.listenerCount('unhandledrejection')).toBe(0);
    win.dispatch('error', { message: 'after teardown' });
    await Promise.resolve();
    expect(uiLogCalls()).toHaveLength(2);
  });

  it('falls back to the error object when the event has no message', async () => {
    const win = createFakeWindow();
    installErrorForwarding(win as unknown as Window);
    win.dispatch('error', { message: '', error: 'string thrown' });
    await Promise.resolve();
    expect(uiLogCalls()[0].message).toBe('window.onerror: string thrown');
  });
});

describe('startUiTelemetry', () => {
  let heartbeatHandler: ((event: { payload: { seq: number; sent_at_ms: number } }) => void) | undefined;
  const unlisten = vi.fn();
  // `window` is defined writable but non-configurable in test-setup.ts, so it
  // is swapped by assignment rather than `vi.stubGlobal`.
  const realWindow = globalThis.window;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockImplementation((async (_name: string, handler: typeof heartbeatHandler) => {
      heartbeatHandler = handler;
      return unlisten;
    }) as unknown as typeof listen);
    unlisten.mockClear();
    heartbeatHandler = undefined;
    (globalThis as { window: unknown }).window = createFakeWindow();
  });

  afterEach(() => {
    (globalThis as { window: unknown }).window = realWindow;
    vi.useRealTimers();
  });

  it('subscribes to ui-heartbeat, acks each seq and emits one health line per interval', async () => {
    const stop = startUiTelemetry();
    await Promise.resolve();
    expect(listen).toHaveBeenCalledWith('ui-heartbeat', expect.any(Function));
    expect(heartbeatHandler).toBeDefined();

    heartbeatHandler!({ payload: { seq: 1, sent_at_ms: Date.now() - 12 } });
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('ui_heartbeat_ack', { seq: 1 });
    let health = uiLogCalls().filter((c) => c.message.startsWith('health '));
    expect(health).toHaveLength(1);
    expect(health[0].level).toBe('info');
    expect(health[0].message).toContain('seq=1 hb_latency=12ms');

    // Second heartbeat inside the interval: acked but no second health line.
    vi.advanceTimersByTime(30_000);
    heartbeatHandler!({ payload: { seq: 2, sent_at_ms: Date.now() } });
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('ui_heartbeat_ack', { seq: 2 });
    expect(uiLogCalls().filter((c) => c.message.startsWith('health '))).toHaveLength(1);

    // Past the interval: a new health line.
    vi.advanceTimersByTime(HEALTH_LOG_INTERVAL_MS);
    heartbeatHandler!({ payload: { seq: 3, sent_at_ms: Date.now() } });
    await Promise.resolve();
    health = uiLogCalls().filter((c) => c.message.startsWith('health '));
    expect(health).toHaveLength(2);
    expect(health[1].message).toContain('seq=3');

    stop();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('installs error forwarding on window and removes it on teardown', () => {
    const win = window as unknown as ReturnType<typeof createFakeWindow>;
    const stop = startUiTelemetry();
    expect(win.listenerCount('error')).toBe(1);
    expect(win.listenerCount('unhandledrejection')).toBe(1);
    stop();
    expect(win.listenerCount('error')).toBe(0);
    expect(win.listenerCount('unhandledrejection')).toBe(0);
  });
});
