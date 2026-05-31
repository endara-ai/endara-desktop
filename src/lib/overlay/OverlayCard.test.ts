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
    dismissAt: null,
    dismissTick: 0,
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

  it('stacked variant reports inflight visual state when any request is in flight', () => {
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

// Row 2 collapses `<server-type> · <server-name>` to a single label when the
// two values are identical (e.g. `gmail · gmail` → `gmail`). Vitest runs
// without jsdom, so we (1) verify the `sameServer` predicate the component's
// `$derived` mirrors and (2) source-grep `OverlayCard.svelte` to confirm the
// `tf-server-name` span + its preceding separator are gated on `!sameServer`
// while the profile suffix is not — i.e. the profile still renders alongside
// the collapsed label.
describe('OverlayCard — collapsed row 2 when serverType === serverName', () => {
  // Mirrors the `$derived` in OverlayCard.svelte. Kept inline so the test
  // exercises the exact predicate the template uses.
  const sameServer = (group: ToolCallGroup) =>
    group.serverType != null &&
    group.serverName != null &&
    group.serverType === group.serverName;

  it('predicate is true when both sides are non-null and equal', () => {
    expect(sameServer(g({ serverType: 'gmail', serverName: 'gmail' }))).toBe(true);
  });

  it('predicate is false when sides differ or either is null', () => {
    expect(sameServer(g({ serverType: 'GitHub', serverName: 'repo' }))).toBe(false);
    expect(sameServer(g({ serverType: null, serverName: 'gmail' }))).toBe(false);
    expect(sameServer(g({ serverType: 'gmail', serverName: null }))).toBe(false);
    // Case-sensitive: `Gmail` vs `gmail` must not collapse.
    expect(sameServer(g({ serverType: 'Gmail', serverName: 'gmail' }))).toBe(false);
  });

  it('OverlayCard.svelte gates tf-server-name on {#if !sameServer} and leaves profile unconditional', async () => {
    // `?raw` returns the component source as a string — same technique the
    // ToastFeed overflow-mask test uses to assert markup without a DOM.
    const src = (await import('./OverlayCard.svelte?raw')).default as string;

    // The `tf-server-name` span and its preceding `·` separator must live
    // inside a `{#if !sameServer}` block.
    expect(src).toMatch(
      /\{#if !sameServer\}\s*<span class="tf-sep">·<\/span>\s*<span class="tf-server-name">/,
    );

    // Exactly one `tf-server-name` span exists in row 2 (so the gmail/gmail
    // case renders one label, not two).
    const serverNameMatches = src.match(/class="tf-server-name"/g) ?? [];
    expect(serverNameMatches).toHaveLength(1);

    // The profile suffix must still render alongside the collapsed label.
    expect(src).toMatch(
      /\{#if showProfile && group\.profile\}\s*<span class="tf-sep">·<\/span>\s*<span class="tf-profile">/,
    );
  });
});


// Per-card dismiss progress bar. The card renders the bar only when
// the group has settled (no in-flight requests AND at least one
// resolved request). The colour is `--healthy` (green) when no errors
// landed and `--offline` (red) the moment any error did. The bar's
// CSS keyframe is re-mounted via `{#key group.dismissTick}` so each
// (re)arm starts the animation from 0% width.
describe('OverlayCard — per-card dismiss bar', () => {
  // Mirrors the `$derived` predicates in OverlayCard.svelte.
  const showBar = (group: ToolCallGroup) =>
    group.inflight === 0 && (group.success > 0 || group.error > 0);
  const barColor = (group: ToolCallGroup) =>
    group.error > 0 ? 'var(--offline)' : 'var(--healthy)';

  it('does NOT render while in-flight (group.inflight > 0)', () => {
    const group = g({ inflight: 1, requests: [req()] });
    expect(showBar(group)).toBe(false);
  });

  it('does NOT render when no request has resolved yet', () => {
    const group = g({ inflight: 0, requests: [] });
    expect(showBar(group)).toBe(false);
  });

  it('renders once the group has settled (success only)', () => {
    const group = g({
      inflight: 0,
      success: 1,
      requests: [req({ status: 'success', durationMs: 100 })],
    });
    expect(showBar(group)).toBe(true);
    expect(barColor(group)).toBe('var(--healthy)');
  });

  it('renders once the group has settled (error only)', () => {
    const group = g({
      inflight: 0,
      error: 1,
      requests: [req({ status: 'error', durationMs: 50 })],
    });
    expect(showBar(group)).toBe(true);
    expect(barColor(group)).toBe('var(--offline)');
  });

  it('colours red as soon as ANY error landed on a mixed group', () => {
    const group = g({
      inflight: 0,
      success: 4,
      error: 1,
      requests: [
        req({ requestId: 'a', status: 'success', durationMs: 100 }),
        req({ requestId: 'b', status: 'error', durationMs: 50 }),
      ],
    });
    expect(showBar(group)).toBe(true);
    expect(barColor(group)).toBe('var(--offline)');
  });

  it('hides again when a new request arrives mid-countdown (inflight flips back > 0)', () => {
    const group = g({
      inflight: 1,
      success: 1,
      requests: [
        req({ requestId: 'a', status: 'success', durationMs: 100 }),
        req({ requestId: 'b', status: 'inflight' }),
      ],
    });
    expect(showBar(group)).toBe(false);
  });

  it('OverlayCard.svelte wires the bar markup, `{#key barTick}`, and the inline style bindings', async () => {
    const src = (await import('./OverlayCard.svelte?raw')).default as string;
    // The bar lives inside the card button, keyed on `barTick`.
    expect(src).toMatch(/\{#if showBar\}/);
    expect(src).toMatch(/\{#key barTick\}/);
    expect(src).toMatch(/class="tf-dismiss-bar"/);
    expect(src).toMatch(/class="tf-dismiss-fill"/);
    expect(src).toMatch(/style:background=\{barColor\}/);
    expect(src).toMatch(/style:animation-duration="\{dismissDurationMs\}ms"/);
    // No animation-play-state binding — hover-pause is gone.
    expect(src).not.toMatch(/animation-play-state/);
  });

  it('OverlayCard.svelte derives barTick from `group.dismissTick`', async () => {
    const src = (await import('./OverlayCard.svelte?raw')).default as string;
    expect(src).toMatch(/const barTick = \$derived\(group\.dismissTick\)/);
  });
});
