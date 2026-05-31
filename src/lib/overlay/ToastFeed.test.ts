// Tests for the `ToastFeed.svelte` derivation pipeline. Vitest runs without
// jsdom, so we drive the same `visibleGroups` / `hiddenGroupCount` helpers
// the component invokes through `$derived` and assert the slicing rules
// (newest-at-bottom, "+N earlier" overflow row).
import { describe, it, expect } from 'vitest';
import { get } from 'svelte/store';
import {
  hiddenGroupCount,
  visibleGroups,
  type OverlayPosition,
} from './overlay-helpers';
import { createToastStore } from './toastStore';
import type { StartedEvent } from './types';

function startEv(over: Partial<StartedEvent> = {}): StartedEvent {
  return {
    kind: 'started',
    request_id: 'r',
    ts: 'ts',
    endpoint: 'github',
    transport: 'stdio',
    server_type: 'github',
    server_name: 'github',
    profile: null,
    tool: 'list_issues',
    ...over,
  };
}

describe('ToastFeed — visible window slicing', () => {
  it('shows every group when total <= maxVisible', () => {
    const store = createToastStore();
    for (let i = 0; i < 3; i++) {
      store.addStarted(startEv({ request_id: `r-${i}`, tool: `tool-${i}` }));
    }
    const groups = get(store);
    const visible = visibleGroups(groups, 7);
    expect(visible).toHaveLength(3);
    expect(hiddenGroupCount(groups.length, 7)).toBe(0);
  });

  it('keeps only the newest `maxVisible` groups when overflowing', () => {
    const store = createToastStore();
    for (let i = 0; i < 10; i++) {
      store.addStarted(startEv({ request_id: `r-${i}`, tool: `tool-${i}` }));
    }
    const groups = get(store);
    expect(groups).toHaveLength(10);

    const visible = visibleGroups(groups, 7);
    expect(visible).toHaveLength(7);
    expect(visible.map((g) => g.tool)).toEqual([
      'tool-3',
      'tool-4',
      'tool-5',
      'tool-6',
      'tool-7',
      'tool-8',
      'tool-9',
    ]);
    expect(hiddenGroupCount(groups.length, 7)).toBe(3);
  });

  it('renders the "+N earlier" marker only when there is overflow', () => {
    expect(hiddenGroupCount(5, 7)).toBe(0);
    expect(hiddenGroupCount(8, 7)).toBe(1);
    expect(hiddenGroupCount(20, 7)).toBe(13);
  });

  it('newest groups land at the end (bottom) of the visible slice', () => {
    const store = createToastStore();
    store.addStarted(startEv({ request_id: 'a', tool: 'first' }));
    store.addStarted(startEv({ request_id: 'b', tool: 'second' }));
    const visible = visibleGroups(get(store), 7);
    expect(visible[visible.length - 1].tool).toBe('second');
  });
});

describe('ToastFeed — position attribute', () => {
  it('exposes the documented `OverlayPosition` literal set', () => {
    // Lock the contract used by the route + future configuration. Adding a
    // value here must be paired with `overlay.css` selectors that anchor it.
    const positions: OverlayPosition[] = [
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
    ];
    expect(positions).toHaveLength(4);
  });

  it('uses the `position` prop to drive the slide direction on the feed-inner wrapper', async () => {
    // The slide-in / slide-out direction is computed in ToastFeed from
    // `position` — right-anchored positions slide toward +x, left-anchored
    // toward −x. With the group-level redesign the directives live on the
    // `.tf-feed-inner` container, gated by `{#if visible.length > 0}`,
    // so the whole stack slides in/out as one unit.
    const src = (await import('./ToastFeed.svelte?raw')).default as string;
    expect(src).toMatch(/slideDir = \$derived\(position\.endsWith\('right'\) \? 1 : -1\)/);
  });
});

// Group-level slide-in / slide-out: the whole `.tf-feed-inner` container
// rides Svelte's stock `in:fly` + `out:fly` transitions, gated by
// `{#if visible.length > 0}` so the stack mounts/unmounts as one unit
// on 0 ↔ N transitions. Per-card slots use a short `in:fade` only (no
// outro) so cards 1 → N fade in subtly without re-triggering the
// horizontal slide. Vitest runs in node (no jsdom), so we source-grep
// the component for the directives and the {#if} gate.
describe('ToastFeed — group-level slide direction + container gate', () => {
  it('right-anchored positions slide toward +x, left-anchored toward −x', () => {
    // Mirrors the `$derived` in ToastFeed.svelte: `position.endsWith('right')
    // ? 1 : -1`. Kept inline so the test exercises the exact predicate.
    const dirFor = (p: OverlayPosition) => (p.endsWith('right') ? 1 : -1);
    expect(dirFor('bottom-right')).toBe(1);
    expect(dirFor('top-right')).toBe(1);
    expect(dirFor('bottom-left')).toBe(-1);
    expect(dirFor('top-left')).toBe(-1);
  });

  it('ToastFeed.svelte wires in:fly + out:fly on the .tf-feed-inner container', async () => {
    const src = (await import('./ToastFeed.svelte?raw')).default as string;
    expect(src).toMatch(/in:fly=\{\{ x: inX,/);
    expect(src).toMatch(/out:fly=\{\{ x: outX,/);
  });

  it('gates the container on {#if visible.length > 0} so it mounts/unmounts on 0 ↔ N', async () => {
    const src = (await import('./ToastFeed.svelte?raw')).default as string;
    expect(src).toMatch(/\{#if visible\.length > 0\}/);
    // The fly directives sit inside the gated `.tf-feed-inner` block.
    const ifIdx = src.indexOf('{#if visible.length > 0}');
    const innerIdx = src.indexOf('class="tf-feed-inner"', ifIdx);
    const inFlyIdx = src.indexOf('in:fly=', ifIdx);
    const outFlyIdx = src.indexOf('out:fly=', ifIdx);
    expect(ifIdx).toBeGreaterThan(-1);
    expect(innerIdx).toBeGreaterThan(ifIdx);
    expect(inFlyIdx).toBeGreaterThan(innerIdx);
    expect(outFlyIdx).toBeGreaterThan(innerIdx);
  });

  it('per-card slot uses a short in:fade only (no per-card outro)', async () => {
    const src = (await import('./ToastFeed.svelte?raw')).default as string;
    // `.tf-card-slot` wrapper carries an `in:fade` for the 1 → N fade-in.
    expect(src).toMatch(/<div class="tf-card-slot" in:fade=\{\{ duration: 120 \}\}>/);
    // No `out:` transition on the per-card slot — the outro is feed-level.
    const slotIdx = src.indexOf('class="tf-card-slot"');
    const eachEndIdx = src.indexOf('{/each}', slotIdx);
    const slotBlock = src.slice(slotIdx, eachEndIdx);
    expect(slotBlock).not.toMatch(/out:/);
    // And OverlayCard.svelte itself must NOT redeclare an outro on its
    // root element either — feed-level dismissal is the only outro.
    const cardSrc = (await import('./OverlayCard.svelte?raw')).default as string;
    expect(cardSrc).not.toMatch(/out:fly=/);
  });

  it('ToastFeed.svelte honours prefers-reduced-motion', async () => {
    const src = (await import('./ToastFeed.svelte?raw')).default as string;
    expect(src).toMatch(/prefers-reduced-motion: reduce/);
  });

  it('uses a short slide magnitude that fits inside the Tauri overlay window', async () => {
    // The Tauri overlay window is 400 logical px wide (OVERLAY_WIDTH in
    // src-tauri/src/overlay.rs) and the `.tf-feed` is `--tf-card-w` + 40
    // = 380px, leaving only ~20 logical px of slack to the screen edge
    // for right-anchored cards. A large slide (e.g. a full card width)
    // is clipped by the OS compositor almost immediately and reads as
    // "vanish". Lock the magnitude to a small, observable value.
    const src = (await import('./ToastFeed.svelte?raw')).default as string;
    expect(src).toMatch(/const slidePx = 80;/);
  });
});

// The horizontal slide-out was previously clipped by
// `.tf-feed-inner { overflow: hidden }` immediately after dismissal —
// the container would translate past the 340px-wide inner column and
// disappear without any visible motion. The fix is to split clipping
// by axis: keep `overflow-y: hidden` so the column stays bounded
// vertically (and the `[data-overflow='true']` mask-image top-edge
// fade still works), but switch the horizontal axis to
// `overflow-x: visible` so the container can slide out of view.
describe('ToastFeed — overlay.css splits inner overflow by axis', () => {
  it('.tf-feed-inner uses overflow-x: visible and overflow-y: hidden', async () => {
    // @ts-expect-error node builtin types not installed
    const { readFileSync } = await import('node:fs');
    // @ts-expect-error node builtin types not installed
    const { fileURLToPath } = await import('node:url');
    const cssPath = fileURLToPath(new URL('./overlay.css', import.meta.url));
    const src = readFileSync(cssPath, 'utf8') as string;
    expect(src).toMatch(/overflow-x:\s*visible;/);
    expect(src).toMatch(/overflow-y:\s*hidden;/);
    // And the old `overflow: hidden` shorthand must NOT be reintroduced
    // on `.tf-feed-inner` — that would re-clip the slide-out.
    expect(src).not.toMatch(
      /\.tf-feed-inner\s*\{[^}]*\soverflow:\s*hidden;[^}]*\}/,
    );
  });
});

// Regression for the unconditional top-edge fade: `.tf-feed-inner`
// previously applied `mask-image` always, so even a single card was
// faded into the desktop. We now gate the mask on a `data-overflow`
// attribute that mirrors `hidden > 0`. Because vitest runs without a
// DOM (env=node), we exercise (1) the logical predicate that drives
// the binding and (2) a source-level grep to guard against future
// edits removing the attribute or the gated CSS selector.
describe('ToastFeed — overflow-gated top-edge mask', () => {
  it('hiddenGroupCount is 0 (data-overflow="false") when total <= maxVisible', () => {
    expect(hiddenGroupCount(3, 7) > 0).toBe(false);
    expect(hiddenGroupCount(7, 7) > 0).toBe(false);
  });

  it('hiddenGroupCount is > 0 (data-overflow="true") when total > maxVisible', () => {
    expect(hiddenGroupCount(8, 7) > 0).toBe(true);
    expect(hiddenGroupCount(20, 7) > 0).toBe(true);
  });

  it('ToastFeed.svelte binds data-overflow to {hidden > 0} on .tf-feed-inner', async () => {
    // Vite's `?raw` query returns the source text as a string — works in
    // the node test env without needing jsdom or @types/node. This guards
    // against future edits silently dropping the attribute that gates the
    // CSS mask rule below (the CSS side is verified by the matching
    // selector check in this same suite).
    const src = (await import('./ToastFeed.svelte?raw')).default as string;
    expect(src).toMatch(/class="tf-feed-inner"\s+data-overflow=\{hidden > 0\}/);
  });

  it('overlay.css scopes the top-edge mask on [data-overflow="true"]', async () => {
    // Vite's CSS pipeline intercepts `.css` imports (even with `?raw`)
    // and returns empty content in the vitest env, so we read the file
    // directly from disk. `@ts-expect-error` because `@types/node` is
    // not installed in this workspace; vitest runs in Node and resolves
    // these at runtime.
    // @ts-expect-error node builtin types not installed
    const { readFileSync } = await import('node:fs');
    // @ts-expect-error node builtin types not installed
    const { fileURLToPath } = await import('node:url');
    const cssPath = fileURLToPath(new URL('./overlay.css', import.meta.url));
    const src = readFileSync(cssPath, 'utf8') as string;
    // The bottom-anchored variant.
    expect(src).toMatch(/\.tf-feed-inner\[data-overflow='true'\]\s*\{/);
    // The top-anchored variant.
    expect(src).toMatch(
      /data-position='top-right'\] \.tf-feed-inner\[data-overflow='true'\]/,
    );
  });
});

// The horizontal slide-out (80px past the inner column's right/left
// edge) previously caused a faint horizontal scrollbar in the overlay
// window during slide-in/out. The fix lives at the viewport boundary:
// `.overlay-root { overflow: clip; clip-path: inset(0) }` plus the
// `::-webkit-scrollbar { display: none }` / `scrollbar-width: none`
// rules in `OverlayApp.svelte`. The `.tf-feed` container itself must
// NOT clip — the inner container slides horizontally past the inner
// column on dismiss (`.tf-feed-inner { overflow-x: visible }`), so any
// clip at this level chops the slide-out animation off on the
// left/right edges.
describe('Overlay window — no scrollbar during slide', () => {
  it('overlay.css does NOT clip .tf-feed (the container slide-out must be able to escape)', async () => {
    // @ts-expect-error node builtin types not installed
    const { readFileSync } = await import('node:fs');
    // @ts-expect-error node builtin types not installed
    const { fileURLToPath } = await import('node:url');
    const cssPath = fileURLToPath(new URL('./overlay.css', import.meta.url));
    const src = readFileSync(cssPath, 'utf8') as string;
    expect(src).not.toMatch(/\.tf-feed\s*\{[^}]*\soverflow:\s*clip;[^}]*\}/);
    expect(src).not.toMatch(/\.tf-feed\s*\{[^}]*\soverflow:\s*hidden;[^}]*\}/);
  });

  it('OverlayApp.svelte uses overflow: clip on html/body + .overlay-root', async () => {
    const src = (await import('./OverlayApp.svelte?raw')).default as string;
    // html/body shorthand must be `clip`, not `hidden` or `auto`/`scroll`.
    expect(src).toMatch(/:global\(html\),\s*:global\(body\)\s*\{[^}]*\soverflow:\s*clip;[^}]*\}/);
    expect(src).not.toMatch(/:global\(html\),\s*:global\(body\)\s*\{[^}]*\soverflow:\s*hidden;[^}]*\}/);
    // .overlay-root must also clip so the fixed-position ancestor
    // doesn't surface a scrollbar.
    expect(src).toMatch(/\.overlay-root\s*\{[^}]*\soverflow:\s*clip;[^}]*\}/);
    expect(src).not.toMatch(/\.overlay-root\s*\{[^}]*\soverflow:\s*hidden;[^}]*\}/);
  });

  it('OverlayApp.svelte applies clip-path: inset(0) on .overlay-root', async () => {
    const src = (await import('./OverlayApp.svelte?raw')).default as string;
    expect(src).toMatch(/\.overlay-root\s*\{[^}]*clip-path:\s*inset\(0\);[^}]*\}/);
  });

  it('OverlayApp.svelte hides webkit + gecko/blink scrollbars', async () => {
    const src = (await import('./OverlayApp.svelte?raw')).default as string;
    expect(src).toMatch(/:global\(::-webkit-scrollbar\)\s*\{[^}]*display:\s*none;[^}]*\}/);
    expect(src).toMatch(
      /:global\(html\),\s*:global\(body\)\s*\{[^}]*scrollbar-width:\s*none;[^}]*\}/,
    );
  });
});

// Ghost-stack "paper" peek cards (`.tf-card-ghost*`) are gone in the
// group-level redesign. The dismiss progress bar lives feed-level (as
// a sibling of the cards inside `.tf-feed-inner`) so its DOM location
// is stable across group reorders. Lock the ghost removal at the
// source level so future regressions are caught.
describe('Overlay redesign — ghost stack stays removed', () => {
  it('OverlayCard.svelte does NOT render .tf-card-ghost peek cards', async () => {
    const src = (await import('./OverlayCard.svelte?raw')).default as string;
    expect(src).not.toMatch(/tf-card-ghost/);
  });

  it('overlay.css drops .tf-card-ghost* (ghost stack stays gone)', async () => {
    // @ts-expect-error node builtin types not installed
    const { readFileSync } = await import('node:fs');
    // @ts-expect-error node builtin types not installed
    const { fileURLToPath } = await import('node:url');
    const cssPath = fileURLToPath(new URL('./overlay.css', import.meta.url));
    const src = readFileSync(cssPath, 'utf8') as string;
    expect(src).not.toMatch(/\.tf-card-ghost/);
  });
});

// Per-card dismiss progress bar: lives inside `OverlayCard` and is
// driven by `group.dismissTick` + `group.inflight`/`group.success`/
// `group.error`. `ToastFeed` no longer owns any bar markup — it just
// pipes `store.getOpts().dismissMs` down to each card as
// `dismissDurationMs` so the CSS keyframe matches the per-group
// `setTimeout` in `toastStore`. No hover-pause: pointer enter/leave
// only toggles Tauri's ignore-cursor-events flag (see `OverlayApp`).
describe('ToastFeed — per-card dismiss bar plumbing', () => {
  it('ToastFeed.svelte pipes `dismissDurationMs` into OverlayCard and renders no feed-level bar', async () => {
    const src = (await import('./ToastFeed.svelte?raw')).default as string;
    // The feed must NOT render its own `.tf-dismiss-bar` / `.tf-dismiss-fill`.
    expect(src).not.toMatch(/class="tf-dismiss-bar"/);
    expect(src).not.toMatch(/class="tf-dismiss-fill"/);
    // No feed-level `{#key dismissTick}` block — keying is per-card.
    expect(src).not.toMatch(/\{#key dismissTick\}/);
    // The shorthand `{dismissDurationMs}` is forwarded to each card.
    expect(src).toMatch(/<OverlayCard[^/]*\{dismissDurationMs\}/);
    // Exactly one `<OverlayCard` tag (one per loop iteration).
    const overlayCardMatches = src.match(/<OverlayCard\b/g) ?? [];
    expect(overlayCardMatches).toHaveLength(1);
  });

  it('ToastFeed.svelte derives dismissDurationMs from `store.getOpts().dismissMs`', async () => {
    const src = (await import('./ToastFeed.svelte?raw')).default as string;
    expect(src).toMatch(
      /const dismissDurationMs = \$derived\(store\.getOpts\(\)\.dismissMs\)/,
    );
  });

  it('ToastFeed.svelte does NOT expose any hover-pause state to OverlayCard', async () => {
    const src = (await import('./ToastFeed.svelte?raw')).default as string;
    expect(src).not.toMatch(/dismissPaused/);
    expect(src).not.toMatch(/pauseDismiss/);
    expect(src).not.toMatch(/resumeDismiss/);
    expect(src).not.toMatch(/animation-play-state/);
  });

  it('OverlayCard.svelte renders the per-card bar markup keyed on group.dismissTick', async () => {
    const src = (await import('./OverlayCard.svelte?raw')).default as string;
    expect(src).toMatch(/class="tf-dismiss-bar"/);
    expect(src).toMatch(/class="tf-dismiss-fill"/);
    // The bar lives inside the card button (the `{#key barTick}` wraps it).
    expect(src).toMatch(/\{#key barTick\}/);
    // Visibility derived from settled-with-results predicate.
    expect(src).toMatch(/group\.inflight === 0/);
    // No `animation-play-state` binding anywhere — hover-pause is gone.
    expect(src).not.toMatch(/animation-play-state/);
  });

  it('OverlayCard.svelte binds the bar colour to green/red via group.error', async () => {
    const src = (await import('./OverlayCard.svelte?raw')).default as string;
    // The `barColor` derivation picks `--offline` on any error, else `--healthy`.
    expect(src).toMatch(/group\.error > 0[\s\S]*var\(--offline\)[\s\S]*var\(--healthy\)/);
    // And the fill element binds it via `style:background={barColor}`.
    expect(src).toMatch(/style:background=\{barColor\}/);
  });

  it('OverlayCard.svelte binds animation-duration to `dismissDurationMs`', async () => {
    const src = (await import('./OverlayCard.svelte?raw')).default as string;
    expect(src).toMatch(/style:animation-duration="\{dismissDurationMs\}ms"/);
  });

  it('OverlayApp.svelte does NOT call pauseDismiss/resumeDismiss on pointer enter/leave', async () => {
    const src = (await import('./OverlayApp.svelte?raw')).default as string;
    expect(src).not.toMatch(/pauseDismiss/);
    expect(src).not.toMatch(/resumeDismiss/);
    // Pointer enter/leave only toggle the Tauri ignore-cursor-events flag.
    expect(src).toMatch(/overlayPointerEnter/);
    expect(src).toMatch(/overlayPointerLeave/);
  });

  it('overlay.css ships @keyframes tfDismissFill and per-card .tf-dismiss-bar/.tf-dismiss-fill rules', async () => {
    // @ts-expect-error node builtin types not installed
    const { readFileSync } = await import('node:fs');
    // @ts-expect-error node builtin types not installed
    const { fileURLToPath } = await import('node:url');
    const cssPath = fileURLToPath(new URL('./overlay.css', import.meta.url));
    const src = readFileSync(cssPath, 'utf8') as string;
    expect(src).toMatch(/@keyframes tfDismissFill\s*\{[^}]*from\s*\{\s*width:\s*0%/);
    expect(src).toMatch(/\.tf-dismiss-bar\s*\{/);
    expect(src).toMatch(/\.tf-dismiss-fill\s*\{/);
    // Per-card bar is absolutely positioned at the bottom of the card.
    expect(src).toMatch(/\.tf-dismiss-bar\s*\{[^}]*position:\s*absolute/);
    expect(src).toMatch(/\.tf-dismiss-bar\s*\{[^}]*bottom:\s*0/);
    expect(src).toMatch(
      /\.tf-dismiss-bar\s*\{[^}]*background:\s*var\(--tf-progress-track\)/,
    );
    // The fill no longer hard-codes a background — colour comes from
    // the inline `style:background={barColor}` on the element.
    expect(src).not.toMatch(/\.tf-dismiss-fill\s*\{[^}]*background:/);
    // No feed-level remnants of the old centralized bar.
    expect(src).not.toMatch(/\.tf-dismiss-bar\s*\{[^}]*margin-top:\s*-8px/);
    expect(src).not.toMatch(
      /\.tf-feed\[data-position\^='top-'\]\s+\.tf-dismiss-bar\s*\{[^}]*order:/,
    );
    // Track variable is still defined in both themes (the card bar
    // reuses it for its idle track colour).
    expect(src).toMatch(/--tf-progress-track:\s*rgba\(0,\s*0,\s*0,\s*0\.06\)/);
    expect(src).toMatch(/--tf-progress-track:\s*rgba\(255,\s*255,\s*255,\s*0\.08\)/);
  });
});
