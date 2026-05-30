<script>
  import '../app.css';
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import { checkAndAutoDownload, listenForUpdateChecks } from '$lib/updater';
  import { activeTopLevelTab } from '$lib/stores';
  import { Toaster } from 'svelte-sonner';

  let { children } = $props();

  // The overlay window (`/overlay/` route) has a narrowly-scoped Tauri
  // capability that intentionally omits the `notification:*` and
  // `updater:*` permissions — `checkAndAutoDownload()` calls into the
  // notification plugin to surface the "update downloaded" toast and
  // would trigger an Unhandled Promise Rejection in the overlay's
  // webview. Detect via `window.location.pathname` so we don't depend
  // on any plugin command being callable from this surface.
  const isOverlayWindow =
    typeof window !== 'undefined' &&
    window.location.pathname.startsWith('/overlay');

  onMount(() => {
    if (isOverlayWindow) return;

    // Check for updates and auto-download 5s after launch
    const initialTimeout = setTimeout(() => checkAndAutoDownload(), 5000);

    // Re-check every 4 hours
    const interval = setInterval(() => checkAndAutoDownload(), 4 * 60 * 60 * 1000);

    // Listen for tray "Check for Updates" event
    const unlisten = listen('check-for-update', () => {
      activeTopLevelTab.set('settings');
      checkAndAutoDownload();
    });

    // Listen for backend `update://checked` events so the UI reflects the
    // channel the updater actually used on every check.
    const unlistenChecked = listenForUpdateChecks();

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(interval);
      unlisten.then((fn) => fn());
      unlistenChecked.then((fn) => fn());
    };
  });
</script>

<Toaster position="bottom-right" duration={5000} richColors closeButton />
{@render children()}

