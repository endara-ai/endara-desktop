// Helper invoked from the overlay window when a card is clicked. Asks the
// host (Rust) to show + focus the main window and emit an `overlay:focus-log`
// window event to the main window so its RelayLogs view can scroll the
// matching log row (keyed by the relay-minted `request_uid`) into view.
//
// Phase 4 will wire `<button onclick=…>` on overlay cards to call this; Phase
// 3 only ships the plumbing.

import { invoke } from '@tauri-apps/api/core';

/**
 * Ask the host to focus the main window on the log row whose request span's
 * `request_uid` matches `logId`.
 *
 * No-op when `logId` is null — defensive guard only. The relay now mints a
 * `request_uid` per request and emits it on every Started event, so a matched
 * sidecar always supplies an id; a null here would indicate a relay/version
 * mismatch rather than normal operation. Surface a console warning so a
 * dropped click is visible in dev-tools.
 */
export async function focusLogForRequest(logId: string | null): Promise<void> {
  if (logId == null) {
    console.warn('[overlay] focusLogForRequest called with null logId; ignoring');
    return;
  }
  try {
    await invoke('focus_main_window_on_log', { logId });
  } catch (e) {
    console.error('[overlay] invoke failed', e);
  }
}
