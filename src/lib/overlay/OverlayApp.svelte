<!--
  Root component rendered into the `/overlay` route. Responsibilities:
    1. Attach the Tauri event bridge on mount (and dispose on unmount).
    2. Mirror the main window's theme onto this window's
       `document.documentElement` via the shared `theme` store + matchMedia.
    3. Render the toast feed.
    4. Toggle the overlay's ignore-cursor-events flag on pointer enter/leave
       so the feed becomes interactive while hovered, click-through otherwise.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import { theme } from '$lib/stores';
  import { attachOverlayBridge } from './eventBridge';
  import { createToastStore } from './toastStore';
  import { emitRenderReady } from './emitRenderReady';
  import {
    DEFAULT_OVERLAY_SETTINGS,
    fetchOverlaySettings,
    overlaySettings,
    subscribeOverlaySettingsChanges,
  } from './overlaySettingsStore';
  import { overlayPointerEnter, overlayPointerLeave } from './overlay-actions';
  import ToastFeed from './ToastFeed.svelte';
  import './overlay.css';

  // Pointer enter/leave toggle the Tauri ignore-cursor-events flag so
  // the feed becomes interactive while hovered (clicking a card focuses
  // the matching log row in the main window) and click-through
  // otherwise. The per-card dismiss timer is intentionally NOT paused
  // on hover — each card's countdown runs to completion regardless of
  // cursor position.

  // One store instance per overlay-window lifetime. Seed with the persisted
  // defaults so the first render uses the correct dismiss timer + visible
  // window even before `fetchOverlaySettings` resolves.
  const store = createToastStore({
    dismissMs: DEFAULT_OVERLAY_SETTINGS.auto_dismiss_ms,
    maxVisible: DEFAULT_OVERLAY_SETTINGS.max_visible,
    showProfile: DEFAULT_OVERLAY_SETTINGS.show_profile,
  });

  function applyTheme(t: 'light' | 'dark' | 'system') {
    const root = document.documentElement;
    let dark: boolean;
    if (t === 'dark') dark = true;
    else if (t === 'light') dark = false;
    else dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', dark);
    if (dark) root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
  }

  onMount(() => {
    // Theme sync: the shared `theme` store already updates documentElement,
    // but it does so once per renderer — the overlay window has its own
    // document, so re-apply here on mount + every subscription tick.
    const unsubTheme = theme.subscribe(applyTheme);

    // Push overlay settings → toast store opts on every change. The Rust
    // side broadcasts `overlay:settings-changed` after every successful
    // write (Settings UI + tray toggle), and `fetchOverlaySettings` seeds
    // the store on mount.
    const unsubSettings = overlaySettings.subscribe((s) => {
      store.setOpts({
        dismissMs: s.auto_dismiss_ms,
        maxVisible: s.max_visible,
        showProfile: s.show_profile,
      });
    });
    fetchOverlaySettings();
    let settingsUnlisten: UnlistenFn | null = null;
    subscribeOverlaySettingsChanges()
      .then((un) => { settingsUnlisten = un; })
      .catch((e) => console.warn('[overlay] settings subscribe failed:', e));

    let disposer: (() => Promise<void>) | null = null;
    attachOverlayBridge(store).then((d) => {
      disposer = d;
    });

    // Signal Rust that the renderer has actually painted a frame so the
    // window can be revealed without the brief white flash that the
    // `on_page_load` reveal produced. See `emitRenderReady.ts` for the
    // handshake details; the Rust side still has a 500ms safety net.
    emitRenderReady();

    return () => {
      unsubTheme();
      unsubSettings();
      if (settingsUnlisten) settingsUnlisten();
      if (disposer) disposer().catch((e) => console.warn('[overlay] disposer failed:', e));
    };
  });

</script>

<svelte:head>
  <title>Endara Overlay</title>
</svelte:head>

<div
  class="overlay-root"
  onpointerenter={() => { void overlayPointerEnter(); }}
  onpointerleave={() => { void overlayPointerLeave(); }}
  role="presentation"
>
  <ToastFeed
    {store}
    position={$overlaySettings.position}
    maxVisible={$overlaySettings.max_visible}
    showProfile={$overlaySettings.show_profile}
  />
</div>

<style>
  /* Defense-in-depth against a faint horizontal scrollbar appearing
   * during card slide-in/out (cards translate 80px past the `.tf-feed`
   * right/left edge):
   *   1. `overflow: clip` on html/body + `.overlay-root` — clips
   *      visually like `hidden` but never creates a scroll container,
   *      unlike `overflow: hidden`.
   *   2. `clip-path: inset(0)` on `.overlay-root` — a paint-time crop
   *      with no scroll-container semantics, no overflow-axis
   *      interaction, no WKWebView quirks. Anything outside the box
   *      is invisible AND cannot generate scrollbars.
   *   3. `::-webkit-scrollbar { display: none }` + `scrollbar-width:
   *      none` — hides the OS/webview scrollbar gutter itself across
   *      WebKit (WKWebView) and Gecko/Blink. The overlay never needs
   *      to scroll, so this is safe.
   * Any one of these would likely suffice; together they cannot
   * produce a scrollbar by construction. */
  :global(html),
  :global(body) {
    margin: 0;
    padding: 0;
    background: transparent !important;
    overflow: clip;
    scrollbar-width: none;
  }
  :global(::-webkit-scrollbar) {
    display: none;
  }
  .overlay-root {
    position: fixed;
    inset: 0;
    background: transparent;
    overflow: clip;
    clip-path: inset(0);
  }
</style>
