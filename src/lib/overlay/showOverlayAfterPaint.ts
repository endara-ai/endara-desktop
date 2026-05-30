// Reveal helper for the overlay window. The Rust builder constructs the
// window with `.visible(false)` so the OS doesn't display the WebView
// before our transparent CSS has painted at least one frame. The renderer
// calls `showOverlayAfterPaint` from `onMount`; the double `rAF` defers
// the Tauri `show_overlay` invoke until after the browser has committed
// the first frame (rAF inside rAF lands after the next paint).
import { invoke } from '@tauri-apps/api/core';

export function showOverlayAfterPaint(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      // Swallow errors: if `show_overlay` is ever unregistered the overlay
      // should still mount and stay hidden rather than throw across the
      // Svelte mount path.
      invoke('show_overlay').catch((e) => {
        console.warn('[overlay] show_overlay invoke failed:', e);
      });
    });
  });
}
