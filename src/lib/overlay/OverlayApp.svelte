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
  onpointerenter={overlayPointerEnter}
  onpointerleave={overlayPointerLeave}
  role="presentation"
>
  <ToastFeed
    {store}
    position={$overlaySettings.position}
    maxVisible={$overlaySettings.max_visible}
    dismissMs={$overlaySettings.auto_dismiss_ms}
    showProfile={$overlaySettings.show_profile}
  />
</div>

<style>
  /* `overflow: clip` (not `hidden`) so these ancestors never create a
   * scroll container. Card slide-in/out translates 80px past the
   * `.tf-feed` right/left edge; with `overflow: hidden` the webview
   * would render a faint horizontal scrollbar on the overlay window
   * during the transition. `clip` clips visually like `hidden` but
   * suppresses the scroll container, so no scrollbar can appear. */
  :global(html),
  :global(body) {
    margin: 0;
    padding: 0;
    background: transparent !important;
    overflow: clip;
  }
  .overlay-root {
    position: fixed;
    inset: 0;
    background: transparent;
    overflow: clip;
  }
</style>
