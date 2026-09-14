import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// Frontend half of the UI health contract (see spec → "IPC contract"):
// - Rust emits `ui-heartbeat` { seq, sent_at_ms } to the main webview every 30 s.
// - We answer with `ui_heartbeat_ack(seq)` and, once per 5 minutes, append one
//   `[ui]` INFO health line to the desktop log via `ui_log(level, message)`.
// - Uncaught errors / unhandled rejections are forwarded via `ui_log` at ERROR.
// Everything here is best-effort: a failing `invoke` must never throw into the
// caller, because these hooks run inside pollers and global error handlers.

export type UiLogLevel = 'error' | 'warn' | 'info' | 'debug';
export type UiLogFn = (level: UiLogLevel, message: string) => void;

export const HEALTH_LOG_INTERVAL_MS = 5 * 60_000;
export const ERROR_LOG_LIMIT_PER_MINUTE = 20;
const STACK_LINES_KEPT = 5;

/** Fire-and-forget `ui_log`; swallows failures (e.g. command not registered). */
export function uiLog(level: UiLogLevel, message: string): void {
  Promise.resolve()
    .then(() => invoke('ui_log', { level, message }))
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Rate limiter (fixed window)
// ---------------------------------------------------------------------------

export interface RateLimiter {
  /** Returns `true` and consumes a slot if under the limit for the current window. */
  allow(nowMs?: number): boolean;
}

export function createRateLimiter(maxPerWindow: number, windowMs: number): RateLimiter {
  let windowStart = Number.NEGATIVE_INFINITY;
  let count = 0;
  return {
    allow(nowMs = Date.now()) {
      if (nowMs - windowStart >= windowMs) {
        windowStart = nowMs;
        count = 0;
      }
      if (count >= maxPerWindow) return false;
      count++;
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// mgmt_api_request round-trip stats + in-flight counter
// ---------------------------------------------------------------------------

export interface RoundTripSnapshot {
  count: number;
  p50Ms: number;
  maxMs: number;
}

export function createRoundTripStats(maxSamples = 1000) {
  let samples: number[] = [];
  return {
    record(ms: number) {
      if (samples.length >= maxSamples) samples.shift();
      samples.push(ms);
    },
    snapshot(): RoundTripSnapshot {
      if (samples.length === 0) return { count: 0, p50Ms: 0, maxMs: 0 };
      const sorted = [...samples].sort((a, b) => a - b);
      return {
        count: sorted.length,
        p50Ms: sorted[Math.floor((sorted.length - 1) / 2)],
        maxMs: sorted[sorted.length - 1],
      };
    },
    reset() {
      samples = [];
    },
  };
}

export interface MgmtSnapshot extends RoundTripSnapshot {
  inFlight: number;
}

export function createMgmtTelemetry() {
  const stats = createRoundTripStats();
  let inFlight = 0;
  return {
    begin() {
      inFlight++;
    },
    end(durationMs: number) {
      inFlight = Math.max(0, inFlight - 1);
      stats.record(durationMs);
    },
    get inFlight() {
      return inFlight;
    },
    snapshot(): MgmtSnapshot {
      return { inFlight, ...stats.snapshot() };
    },
    /** Clear the round-trip window; the in-flight count is live and untouched. */
    resetWindow() {
      stats.reset();
    },
  };
}

/** Process-wide instance fed by `mgmtRequest` in `api.ts`. */
export const mgmtTelemetry = createMgmtTelemetry();

// ---------------------------------------------------------------------------
// 1 s setInterval drift (timer lateness + wall-clock vs. performance.now())
// ---------------------------------------------------------------------------

export interface DriftSnapshot {
  /** Intervals measured since the last window reset. */
  ticks: number;
  /** How late the most recent tick fired relative to the nominal interval. */
  lastLatenessMs: number;
  maxLatenessMs: number;
  /**
   * Accumulated (wall-clock delta − performance.now() delta). Non-zero when
   * the monotonic clock paused (system sleep) or the wall clock was adjusted.
   */
  wallVsPerfDriftMs: number;
}

export function createDriftTracker(intervalMs = 1000) {
  let lastWall: number | null = null;
  let lastPerf = 0;
  let ticks = 0;
  let lastLatenessMs = 0;
  let maxLatenessMs = 0;
  let wallVsPerfDriftMs = 0;
  return {
    tick(wallMs: number, perfMs: number) {
      if (lastWall !== null) {
        const perfDelta = perfMs - lastPerf;
        lastLatenessMs = perfDelta - intervalMs;
        if (lastLatenessMs > maxLatenessMs) maxLatenessMs = lastLatenessMs;
        wallVsPerfDriftMs += (wallMs - lastWall) - perfDelta;
        ticks++;
      }
      lastWall = wallMs;
      lastPerf = perfMs;
    },
    snapshot(): DriftSnapshot {
      return { ticks, lastLatenessMs, maxLatenessMs, wallVsPerfDriftMs };
    },
    resetWindow() {
      ticks = 0;
      lastLatenessMs = 0;
      maxLatenessMs = 0;
      wallVsPerfDriftMs = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Heap figures (Chromium-only `performance.memory`; absent on WebKit)
// ---------------------------------------------------------------------------

export interface HeapFigures {
  usedMB: number;
  totalMB: number;
  limitMB: number;
}

interface MemoryInfoLike {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
  jsHeapSizeLimit?: number;
}

export function readHeapFigures(perf: unknown = globalThis.performance): HeapFigures | null {
  const mem = (perf as { memory?: MemoryInfoLike } | undefined)?.memory;
  if (!mem || typeof mem.usedJSHeapSize !== 'number') return null;
  const mb = (n: number | undefined) => Math.round((n ?? 0) / 1_048_576);
  return { usedMB: mb(mem.usedJSHeapSize), totalMB: mb(mem.totalJSHeapSize), limitMB: mb(mem.jsHeapSizeLimit) };
}

// ---------------------------------------------------------------------------
// Error forwarding (window.onerror / unhandledrejection → ui_log ERROR)
// ---------------------------------------------------------------------------

export function describeReason(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) return { message: `${reason.name}: ${reason.message}`, stack: reason.stack };
  if (typeof reason === 'string') return { message: reason };
  try {
    return { message: JSON.stringify(reason) ?? String(reason) };
  } catch {
    return { message: String(reason) };
  }
}

/** `message` plus the first few non-empty stack lines, flattened to one line. */
export function formatErrorForLog(kind: string, message: string, stack?: string): string {
  const lines = (stack ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, STACK_LINES_KEPT);
  return lines.length > 0 ? `${kind}: ${message} | ${lines.join(' | ')}` : `${kind}: ${message}`;
}

export function createErrorForwarder(opts: { log?: UiLogFn; limiter?: RateLimiter } = {}) {
  const log = opts.log ?? uiLog;
  const limiter = opts.limiter ?? createRateLimiter(ERROR_LOG_LIMIT_PER_MINUTE, 60_000);
  return {
    onError(message: string, stack?: string, nowMs?: number): boolean {
      if (!limiter.allow(nowMs)) return false;
      log('error', formatErrorForLog('window.onerror', message, stack));
      return true;
    },
    onRejection(reason: unknown, nowMs?: number): boolean {
      if (!limiter.allow(nowMs)) return false;
      const { message, stack } = describeReason(reason);
      log('error', formatErrorForLog('unhandledrejection', message, stack));
      return true;
    },
  };
}

export function installErrorForwarding(target: Window): () => void {
  const forwarder = createErrorForwarder();
  const onError = (e: ErrorEvent) => {
    forwarder.onError(e.message || String(e.error ?? 'unknown error'), e.error?.stack);
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    forwarder.onRejection(e.reason);
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

// ---------------------------------------------------------------------------
// Periodic health line + heartbeat listener
// ---------------------------------------------------------------------------

export interface HealthReport {
  seq: number;
  /** `Date.now()` − heartbeat `sent_at_ms`; how long the event took to reach us. */
  heartbeatLatencyMs: number;
  visibility: string;
  drift: DriftSnapshot;
  heap: HeapFigures | null;
  mgmt: MgmtSnapshot;
}

export function formatHealthLine(r: HealthReport): string {
  const ms = (n: number) => `${Math.round(n)}ms`;
  const parts = [
    `health seq=${r.seq}`,
    `hb_latency=${ms(r.heartbeatLatencyMs)}`,
    `visibility=${r.visibility}`,
    `timer_ticks=${r.drift.ticks}`,
    `timer_lateness=${ms(r.drift.lastLatenessMs)}/max=${ms(r.drift.maxLatenessMs)}`,
    `wall_vs_perf_drift=${ms(r.drift.wallVsPerfDriftMs)}`,
    r.heap
      ? `heap_mb=${r.heap.usedMB}/${r.heap.totalMB}/limit=${r.heap.limitMB}`
      : 'heap_mb=n/a',
    `mgmt_inflight=${r.mgmt.inFlight}`,
    `mgmt_rtt_n=${r.mgmt.count}`,
    `mgmt_rtt_p50=${ms(r.mgmt.p50Ms)}`,
    `mgmt_rtt_max=${ms(r.mgmt.maxMs)}`,
  ];
  return parts.join(' ');
}

/** True when at least `intervalMs` has elapsed since the last health line. */
export function shouldEmitHealth(lastEmittedMs: number, nowMs: number, intervalMs = HEALTH_LOG_INTERVAL_MS): boolean {
  return nowMs - lastEmittedMs >= intervalMs;
}

interface HeartbeatPayload {
  seq: number;
  sent_at_ms: number;
}

/**
 * Start the main-window telemetry: heartbeat ack, periodic health line, and
 * global error forwarding. Returns a cleanup function for the layout's
 * `onMount` teardown. The first health line is emitted on the first heartbeat
 * so every session has a baseline; subsequent lines are 5 minutes apart.
 */
export function startUiTelemetry(): () => void {
  const drift = createDriftTracker(1000);
  drift.tick(Date.now(), performance.now());
  const driftInterval = setInterval(() => drift.tick(Date.now(), performance.now()), 1000);
  const removeErrorForwarding = installErrorForwarding(window);

  let lastHealthAt = Number.NEGATIVE_INFINITY;
  const unlisten = listen<HeartbeatPayload>('ui-heartbeat', (event) => {
    const { seq, sent_at_ms } = event.payload;
    Promise.resolve()
      .then(() => invoke('ui_heartbeat_ack', { seq }))
      .catch(() => {});
    const now = Date.now();
    if (!shouldEmitHealth(lastHealthAt, now)) return;
    lastHealthAt = now;
    uiLog(
      'info',
      formatHealthLine({
        seq,
        heartbeatLatencyMs: typeof sent_at_ms === 'number' ? now - sent_at_ms : 0,
        visibility: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
        drift: drift.snapshot(),
        heap: readHeapFigures(),
        mgmt: mgmtTelemetry.snapshot(),
      }),
    );
    drift.resetWindow();
    mgmtTelemetry.resetWindow();
  }).catch(() => () => {});

  return () => {
    clearInterval(driftInterval);
    removeErrorForwarding();
    unlisten.then((fn) => fn());
  };
}
