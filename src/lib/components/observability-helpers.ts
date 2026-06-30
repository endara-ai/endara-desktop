import type { CallSummaryDto, AggregateBucketDto } from '$lib/types';
import type { ToolCallEvent } from '$lib/overlay/types';
import type { ObservabilityCallsFilter } from '$lib/api';

// Pure helpers backing `Observability.svelte` (D2). Extracted as plain
// functions so they can be exercised in the Node test env — the rest of the
// desktop test suite follows the same pattern (logs-tab-helpers,
// detail-panel-helpers, tool-call-row-helpers, ...).

export type StatusFilter = 'all' | 'success' | 'errors';

/** UI-side filter state for the call list, mapped to the relay query below. */
export interface CallsFilterUi {
  serverName: string;
  tool: string;
  status: StatusFilter;
  windowMinutes: number;
  requestUid: string;
  limit: number;
  /**
   * Opaque keyset continuation token returned by the previous page (or
   * `undefined` for the first page). The relay encodes `(tsStart, id)` so
   * paging stays stable across concurrent inserts and is O(limit) at any depth.
   */
  cursor?: string;
}

/**
 * Map the UI filter state to the relay's `ObservabilityCallsFilter`. Empty
 * strings drop out; `status` becomes the tri-state `success` flag; a positive
 * `windowMinutes` becomes a `since` epoch-ms bound (`nowMs` injected for tests).
 */
export function buildCallsFilter(
  ui: CallsFilterUi,
  nowMs: number = Date.now(),
): ObservabilityCallsFilter {
  const filter: ObservabilityCallsFilter = { limit: ui.limit };
  if (ui.cursor) filter.cursor = ui.cursor;
  const server = ui.serverName.trim();
  if (server) filter.server_name = server;
  const tool = ui.tool.trim();
  if (tool) filter.tool = tool;
  const requestUid = ui.requestUid.trim();
  if (requestUid) filter.request_uid = requestUid;
  if (ui.status === 'success') filter.success = true;
  else if (ui.status === 'errors') filter.success = false;
  if (ui.windowMinutes > 0) filter.since = nowMs - ui.windowMinutes * 60_000;
  return filter;
}

/** Wall-clock time for a row (epoch ms). Locale-formatted; guards bad input. */
export function formatTime(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Duration in ms → `312 ms` / `1.20 s`. */
export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Base-1024 byte formatter. Non-finite/negative → `—`. */
export function formatBytes(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 'B';
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(1)} ${unit}`;
}

/** Status pill text + ok flag for a row. Accepts both the list summary and
 * the drill-through full record — only `success` is read. */
export function callStatus(record: { success: boolean }): { ok: boolean; label: string } {
  if (record.success) return { ok: true, label: 'success' };
  return { ok: false, label: 'error' };
}

/** Only the global (server-less) aggregate buckets, ordered by bucketStart. */
export function globalBuckets(buckets: readonly AggregateBucketDto[]): AggregateBucketDto[] {
  return buckets
    .filter((b) => b.server === undefined || b.server === null)
    .slice()
    .sort((a, b) => a.bucketStart - b.bucketStart);
}

/** Pull one numeric series out of the buckets for a sparkline. */
export function bucketSeries(
  buckets: readonly AggregateBucketDto[],
  field: 'count' | 'errorCount' | 'p50Ms' | 'p95Ms',
): number[] {
  return buckets.map((b) => b[field] ?? 0);
}

export interface SparklineOptions {
  width: number;
  height: number;
  padding?: number;
  /**
   * Optional shared Y-domain. When supplied, the series is scaled against this
   * range instead of its own min/max, so multiple polylines (e.g. p50/p95) are
   * directly comparable on one scale.
   */
  min?: number;
  max?: number;
}

/**
 * Combined min/max across several series, for use as a shared `sparklinePoints`
 * domain. Empty input yields `{ min: 0, max: 0 }`.
 */
export function combinedDomain(
  series: readonly (readonly number[])[],
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const v of s) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0 };
  return { min, max };
}

/**
 * Map a hover ratio (0..1 across the sparkline width) to the nearest bucket
 * index. Used by `Sparkline.svelte`'s pointer-move readout. Out-of-range or
 * non-finite ratios clamp to the valid `[0, length - 1]` range; an empty or
 * single-point series always yields `0`.
 */
export function nearestIndex(ratio: number, length: number): number {
  if (length <= 1) return 0;
  if (!Number.isFinite(ratio)) return 0;
  const raw = Math.round(ratio * (length - 1));
  return Math.min(length - 1, Math.max(0, raw));
}

/**
 * Map a numeric series to an SVG polyline `points` string scaled to fit the
 * box. Flat/single-value series render as a centred horizontal line. Min/max
 * default to the series' own range, but a shared `{ min, max }` domain can be
 * passed so multiple series share one vertical scale.
 */
export function sparklinePoints(values: readonly number[], opts: SparklineOptions): string {
  const { width, height } = opts;
  const pad = opts.padding ?? 1;
  if (values.length === 0) return '';
  const midY = (height / 2).toFixed(2);
  if (values.length === 1) return `${pad},${midY} ${(width - pad).toFixed(2)},${midY}`;
  const max = opts.max ?? Math.max(...values);
  const min = opts.min ?? Math.min(...values);
  const range = max - min || 1;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const step = innerW / (values.length - 1);
  return values
    .map((v, i) => {
      const x = pad + i * step;
      const y = pad + innerH - ((v - min) / range) * innerH;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

/** A `tool-call-event` is terminal (produced a metadata row) when settled. */
export function isTerminalEvent(event: ToolCallEvent | unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const kind = (event as { kind?: unknown }).kind;
  return kind === 'completed' || kind === 'failed';
}

/**
 * Merge two call lists, dedupe by `requestUid` (incoming wins so a refetch
 * refreshes existing rows), and sort newest-first by `tsStart`.
 */
export function mergeCalls(
  existing: readonly CallSummaryDto[],
  incoming: readonly CallSummaryDto[],
): CallSummaryDto[] {
  const byUid = new Map<string, CallSummaryDto>();
  for (const c of existing) byUid.set(c.requestUid, c);
  for (const c of incoming) byUid.set(c.requestUid, c);
  return [...byUid.values()].sort((a, b) => b.tsStart - a.tsStart);
}

/** Distinct, sorted values of one field across a call list (for filter menus). */
export function distinctValues(
  calls: readonly CallSummaryDto[],
  field: 'serverName' | 'tool',
): string[] {
  const set = new Set<string>();
  for (const c of calls) {
    const v = c[field];
    if (v) set.add(v);
  }
  return [...set].sort();
}

/**
 * Parse a payload string into a value suitable for the collapsible JSON tree
 * viewer. Returns `{ ok: true, value }` only when the text is within `maxChars`
 * (a size guard so huge blobs never parse-and-hang), parses as JSON, and is a
 * non-null object/array (the tree viewer expects an object or array). Otherwise
 * `{ ok: false }` so callers fall back to the raw `<pre>` view via `prettyJson`.
 */
export function parseJsonTree(
  raw: string,
  maxChars = 200_000,
): { ok: true; value: object } | { ok: false } {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxChars) {
    return { ok: false };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === 'object') return { ok: true, value };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Absolute ceiling on the input size we are willing to `JSON.parse` +
 * re-stringify. Past this, even an effectively-unlimited `maxChars` (the copy
 * path passes `Number.MAX_SAFE_INTEGER`) must not parse, or the multi-megabyte
 * blob would block the UI thread.
 */
const PRETTY_PARSE_CEILING = 1_000_000;

/** Pretty-print a JSON string; falls back to the raw text. Caps display size. */
export function prettyJson(raw: string, maxChars = 200_000): { text: string; truncated: boolean } {
  // Early size guard: when the raw input is past the absolute ceiling or far
  // larger than the display cap, skip the parse entirely and return truncated
  // raw text. This avoids parse-and-hang on huge payloads (and stops
  // `copyPayload`'s `Number.MAX_SAFE_INTEGER` cap from defeating the guard).
  if (raw.length > PRETTY_PARSE_CEILING || raw.length > maxChars * 4) {
    return { text: raw.slice(0, Math.min(maxChars, PRETTY_PARSE_CEILING)), truncated: true };
  }
  let text = raw;
  try {
    text = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    text = raw;
  }
  if (text.length > maxChars) return { text: text.slice(0, maxChars), truncated: true };
  return { text, truncated: false };
}

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Cancel a pending trailing call (e.g. on component destroy). */
  cancel(): void;
}

/**
 * Trailing-edge debounce: collapses bursts of calls into a single invocation
 * `delayMs` after the last one. Used to make the filter inputs search-as-you-
 * type without a reload storm. `cancel()` clears any pending timer.
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = ((...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delayMs);
  }) as Debounced<A>;
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}
