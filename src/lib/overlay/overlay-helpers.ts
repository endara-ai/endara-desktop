// Pure helpers backing the overlay UI components. Extracted so they can be
// unit-tested in the Node vitest environment (no jsdom). The Svelte
// components in this folder import these helpers for their derivation logic
// and keep markup-only concerns inside the `.svelte` files.

import type { ToolCallGroup } from './toastStore';
import type { ClientIdentity, ToolCallAnnotations } from './types';

/** Aggregate visual state for a group, derived from its inflight/error/success counts. */
export type GroupVisualState = 'inflight' | 'success' | 'fail';

export function groupVisualState(g: ToolCallGroup): GroupVisualState {
  if (g.inflight > 0) return 'inflight';
  if (g.error > 0 && g.success === 0) return 'fail';
  return 'success';
}

/** Whether a group should render the literal stacked ghost cards behind it. */
export function isStacked(g: ToolCallGroup): boolean {
  return g.requests.length > 1;
}

/** Annotation → hint kind mapping (prototype `HINT_META` + tone). */
export type HintKind = 'readonly' | 'idempotent' | 'openworld' | 'destructive';

export type HintMeta = {
  kind: HintKind;
  label: string;
  tone: 'muted' | 'warn' | 'danger';
};

const HINT_TABLE: Record<HintKind, HintMeta> = {
  readonly: { kind: 'readonly', label: 'read-only', tone: 'muted' },
  idempotent: { kind: 'idempotent', label: 'idempotent', tone: 'muted' },
  openworld: { kind: 'openworld', label: 'open-world', tone: 'warn' },
  destructive: { kind: 'destructive', label: 'destructive', tone: 'danger' },
};

/** Resolve hint pill metadata for an annotations payload. Returns ordered list. */
export function hintsForAnnotations(a: ToolCallAnnotations | undefined): HintMeta[] {
  if (!a) return [];
  const out: HintMeta[] = [];
  if (a.read_only) out.push(HINT_TABLE.readonly);
  if (a.idempotent) out.push(HINT_TABLE.idempotent);
  if (a.open_world) out.push(HINT_TABLE.openworld);
  if (a.destructive) out.push(HINT_TABLE.destructive);
  return out;
}

/** Average duration in ms across resolved requests, or null if none resolved. */
export function averageDurationMs(g: ToolCallGroup): number | null {
  const resolved = g.requests.filter((r) => typeof r.durationMs === 'number');
  if (resolved.length === 0) return null;
  const sum = resolved.reduce((s, r) => s + (r.durationMs ?? 0), 0);
  return Math.round(sum / resolved.length);
}

/** Latest request in a group (most recently pushed). */
export function latestRequest(g: ToolCallGroup) {
  return g.requests[g.requests.length - 1] ?? null;
}

/** Slice the visible window of groups; render newest at bottom (matches prototype). */
export function visibleGroups<T>(groups: readonly T[], maxVisible: number): T[] {
  if (maxVisible <= 0 || groups.length <= maxVisible) return groups.slice();
  return groups.slice(-maxVisible);
}

/** Count of groups beyond the visible window — fed into the "+N earlier" row. */
export function hiddenGroupCount(total: number, maxVisible: number): number {
  if (maxVisible <= 0) return 0;
  return Math.max(0, total - maxVisible);
}

/** Whether the card click should attempt to focus a log row. */
export function canFocusLog(g: ToolCallGroup): boolean {
  const last = latestRequest(g);
  return !!last && last.logId != null;
}

/** Normalize the prototype's destructive flag onto the typed annotation. */
export function isDestructive(g: ToolCallGroup): boolean {
  return g.annotations?.destructive === true;
}

/**
 * Axis-aligned card hit rect in overlay-window viewport coordinates (CSS /
 * logical pixels). Mirrors the `HitRect` struct in `src-tauri/src/overlay.rs`.
 * `log_id` carries the relay-minted `request_uid` (surfaced to the desktop side
 * as `logId`) so the macOS click-catcher can emit `overlay:card-clicked` with
 * the right target (empty string when the card has no `request_uid` captured
 * yet). The snake_case key matches the wire shape serde deserializes on the
 * Rust side.
 */
export type HitRect = { x: number; y: number; width: number; height: number; log_id: string };

/** Minimal element shape needed to measure a hit rect (testable without jsdom). */
type Measurable = {
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  dataset?: { logId?: string };
};

/**
 * Measure the bounding rects of the visible card elements, tagging each with
 * the `data-log-id` the renderer stamped on the slot. Zero-area rects
 * (display:none, not yet laid out) are dropped so the Rust side never treats a
 * collapsed element as a click target.
 */
export function collectHitRects(elements: Iterable<Measurable | null | undefined>): HitRect[] {
  const out: HitRect[] = [];
  for (const el of elements) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) continue;
    out.push({ x: r.x, y: r.y, width: r.width, height: r.height, log_id: el.dataset?.logId ?? '' });
  }
  return out;
}

/** Valid overlay positions; the route default is `bottom-right`. */
export type OverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export const DEFAULT_OVERLAY_POSITION: OverlayPosition = 'bottom-right';

/**
 * Resolve a short, friendly caller label for the overlay card.
 *
 * Returns `client.label` (trimmed) when present — the relay's friendly display
 * label; otherwise `client.name` (trimmed, without version); otherwise a
 * friendly label derived from `user_agent` (the leading product token, before
 * the first `/`); otherwise `null` when no caller signal is known. "Missing
 * key" and explicit `null`/empty values are treated identically.
 */
export function callerLabel(client: ClientIdentity | null | undefined): string | null {
  if (!client) return null;
  const label = typeof client.label === 'string' ? client.label.trim() : '';
  if (label.length > 0) return label;
  const name = typeof client.name === 'string' ? client.name.trim() : '';
  if (name.length > 0) return name;
  const ua = typeof client.user_agent === 'string' ? client.user_agent.trim() : '';
  if (ua.length > 0) {
    // Pull the leading product token from a typical `product/version …` UA.
    // Falls back to the raw UA when no `/` is present.
    const slash = ua.indexOf('/');
    const head = slash >= 0 ? ua.slice(0, slash).trim() : ua;
    if (head.length > 0) return head;
  }
  return null;
}
