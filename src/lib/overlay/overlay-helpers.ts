// Pure helpers backing the overlay UI components. Extracted so they can be
// unit-tested in the Node vitest environment (no jsdom). The Svelte
// components in this folder import these helpers for their derivation logic
// and keep markup-only concerns inside the `.svelte` files.

import type { ToolCallGroup } from './toastStore';
import type { ToolCallAnnotations } from './types';

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
  return !!last && last.jsonrpcId != null;
}

/** Normalize the prototype's destructive flag onto the typed annotation. */
export function isDestructive(g: ToolCallGroup): boolean {
  return g.annotations?.destructive === true;
}

/** Valid overlay positions; the route default is `bottom-right`. */
export type OverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export const DEFAULT_OVERLAY_POSITION: OverlayPosition = 'bottom-right';
