// Signal Rust that the overlay webview has actually painted at least one
// frame, so the Tauri side can flip the window from `.visible(false)` to
// shown without the brief white flash that `on_page_load` + an immediate
// `show()` produced (page-load fires before the transparent CSS has been
// composited).
//
// Handshake: double `requestAnimationFrame` to skip past the layout +
// initial paint, then emit a window-scoped `overlay-render-ready` event
// via `getCurrentWindow().emit(...)`. The Rust side registers a one-shot
// listener in `build_overlay_window` that calls `window.show()` on
// receipt. A 500ms `async_runtime::spawn` safety net on the Rust side
// still covers renderer crash / event-system failure.
//
// We use the event channel (not `invoke()`) because the previous
// renderer-invoke attempt failed and event emit only needs
// `core:event:default` (bundled into `core:default`, which the overlay
// capability already grants).
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Schedule a render-ready signal to be emitted after the next composited
 * paint. Safe to call from `onMount`: all failures are caught and logged
 * — never thrown — so a misbehaving Tauri runtime cannot break the
 * overlay's mount path.
 */
export function emitRenderReady(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        const w = getCurrentWindow();
        w.emit('overlay-render-ready', null).catch((e) => {
          console.warn('[overlay] emit overlay-render-ready failed:', e);
        });
      } catch (e) {
        console.warn('[overlay] getCurrentWindow failed:', e);
      }
    });
  });
}
