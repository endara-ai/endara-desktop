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

  it('uses the `position` prop to drive the slide direction at the each-block wrapper', async () => {
    // The slide-in / slide-out direction is computed in ToastFeed from
    // `position` — right-anchored positions slide toward +x, left-anchored
    // toward −x. The directives live on the wrapper around `<OverlayCard>`
    // (the immediate keyed child of `{#each}`), not inside the card itself,
    // so the outro plays on dismiss.
    const src = (await import('./ToastFeed.svelte?raw')).default as string;
    expect(src).toMatch(/slideDir = \$derived\(position\.endsWith\('right'\) \? 1 : -1\)/);
  });
});

// Slide-in / slide-out animation driven by overlay corner. The card slot
// wrapper rides Svelte's stock `in:fly` + `out:fly` transitions; the
// slide direction must mirror the position prop so right-anchored cards
// travel toward +x and left-anchored toward −x. Both directives must
// live on the immediate keyed child of the each block — if they sat on
// the root of `OverlayCard.svelte` instead, Svelte would tear the
// component down synchronously and the outro would never play (which
// was the original slide-out regression). Vitest runs in node (no
// jsdom), so we source-grep the component for the direction branch and
// the transition wiring.
describe('ToastFeed — position-driven slide direction', () => {
  it('right-anchored positions slide toward +x, left-anchored toward −x', () => {
    // Mirrors the `$derived` in ToastFeed.svelte: `position.endsWith('right')
    // ? 1 : -1`. Kept inline so the test exercises the exact predicate.
    const dirFor = (p: OverlayPosition) => (p.endsWith('right') ? 1 : -1);
    expect(dirFor('bottom-right')).toBe(1);
    expect(dirFor('top-right')).toBe(1);
    expect(dirFor('bottom-left')).toBe(-1);
    expect(dirFor('top-left')).toBe(-1);
  });

  it('ToastFeed.svelte wires in:fly + out:fly on the each-block child', async () => {
    const src = (await import('./ToastFeed.svelte?raw')).default as string;
    expect(src).toMatch(/in:fly=\{\{ x: inX,/);
    expect(src).toMatch(/out:fly=\{\{ x: outX,/);
  });

  it('places in:/out: directives on the immediate keyed child of {#each}, not inside OverlayCard', async () => {
    // Svelte plays an `out:` transition only when it sits on the keyed
    // child of the `{#each}` block. The wrapping `<div>` must therefore
    // appear in source order BEFORE `<OverlayCard>` and carry both
    // directives; if the previous attempt at this feature put them on
    // OverlayCard's root element, the dismissal would be instant.
    const feedSrc = (await import('./ToastFeed.svelte?raw')).default as string;
    const eachIdx = feedSrc.indexOf('{#each visible as g (g.id)}');
    expect(eachIdx).toBeGreaterThan(-1);
    const inFlyIdx = feedSrc.indexOf('in:fly=', eachIdx);
    const outIdx = feedSrc.indexOf('out:fly=', eachIdx);
    const cardIdx = feedSrc.indexOf('<OverlayCard', eachIdx);
    expect(inFlyIdx).toBeGreaterThan(eachIdx);
    expect(outIdx).toBeGreaterThan(eachIdx);
    expect(cardIdx).toBeGreaterThan(eachIdx);
    // Wrapper-then-card ordering: both directives must appear before the
    // `<OverlayCard>` tag so they sit on the surrounding `<div>`.
    expect(inFlyIdx).toBeLessThan(cardIdx);
    expect(outIdx).toBeLessThan(cardIdx);

    // And OverlayCard.svelte itself must NOT redeclare an outro on its
    // root element — that would re-introduce the synchronous-unmount bug.
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
// the card's slot would translate past the 340px-wide inner column and
// disappear without any visible motion. The fix is to split clipping
// by axis: keep `overflow-y: hidden` so the column stays bounded
// vertically (and the `[data-overflow='true']` mask-image top-edge
// fade still works), but switch the horizontal axis to
// `overflow-x: visible` so the card can slide out of the inner column.
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
    expect(src).toMatch(/class="tf-feed-inner" data-overflow=\{hidden > 0\}/);
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
// NOT clip — cards slide horizontally past the inner column on
// dismiss (`.tf-feed-inner { overflow-x: visible }`), so any clip at
// this level chops the slide-out animation off on the left/right
// edges.
describe('Overlay window — no scrollbar during slide', () => {
  it('overlay.css does NOT clip .tf-feed (the card slide-out must be able to escape)', async () => {
    // @ts-expect-error node builtin types not installed
    const { readFileSync } = await import('node:fs');
    // @ts-expect-error node builtin types not installed
    const { fileURLToPath } = await import('node:url');
    const cssPath = fileURLToPath(new URL('./overlay.css', import.meta.url));
    const src = readFileSync(cssPath, 'utf8') as string;
    // Neither `overflow: clip` nor `overflow: hidden` may sit on
    // `.tf-feed` — both would crop the card's horizontal slide-out
    // animation on the left/right edges (where the container is only
    // 20px wider than the card itself). The scrollbar suppression
    // lives one level up, on `.overlay-root` (see the OverlayApp
    // assertions below).
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

  // Defense-in-depth on top of `overflow: clip`: a `clip-path: inset(0)`
  // paint-time crop on `.overlay-root` has no scroll-container semantics
  // and no overflow-axis interaction, so it cannot surface a scrollbar
  // even if a WKWebView quirk ignores `overflow: clip` on some path.
  // Pair it with `::-webkit-scrollbar { display: none }` and
  // `scrollbar-width: none` to hide the OS/webview scrollbar gutter
  // itself across WebKit and Gecko/Blink — the overlay is not supposed
  // to scroll anyway.
  it('OverlayApp.svelte applies clip-path: inset(0) on .overlay-root', async () => {
    const src = (await import('./OverlayApp.svelte?raw')).default as string;
    expect(src).toMatch(/\.overlay-root\s*\{[^}]*clip-path:\s*inset\(0\);[^}]*\}/);
  });

  it('OverlayApp.svelte hides webkit + gecko/blink scrollbars', async () => {
    const src = (await import('./OverlayApp.svelte?raw')).default as string;
    // WebKit / WKWebView scrollbar gutter.
    expect(src).toMatch(/:global\(::-webkit-scrollbar\)\s*\{[^}]*display:\s*none;[^}]*\}/);
    // Gecko / Blink scrollbar gutter on html + body.
    expect(src).toMatch(
      /:global\(html\),\s*:global\(body\)\s*\{[^}]*scrollbar-width:\s*none;[^}]*\}/,
    );
  });
});
