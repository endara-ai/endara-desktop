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
  import { theme } from '$lib/stores';
  import { attachOverlayBridge } from './eventBridge';
  import { createToastStore } from './toastStore';
  import { DEFAULT_OVERLAY_POSITION } from './overlay-helpers';
  import { overlayPointerEnter, overlayPointerLeave } from './overlay-actions';
  import ToastFeed from './ToastFeed.svelte';
  import './overlay.css';

  // One store instance per overlay-window lifetime.
  const store = createToastStore();

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

    let disposer: (() => Promise<void>) | null = null;
    attachOverlayBridge(store).then((d) => {
      disposer = d;
    });

    return () => {
      unsubTheme();
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
  <ToastFeed {store} position={DEFAULT_OVERLAY_POSITION} />
</div>

<style>
  :global(html),
  :global(body) {
    margin: 0;
    padding: 0;
    background: transparent !important;
    overflow: hidden;
  }
  .overlay-root {
    position: fixed;
    inset: 0;
    background: transparent;
  }
</style>
