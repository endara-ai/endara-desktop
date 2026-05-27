// Helper invoked from the overlay window when a card is clicked. Asks the
// host (Rust) to show + focus the main window and emit an `overlay:focus-log`
// window event to the main window so its RelayLogs view can scroll the
// matching `request{id="..."}` row into view.
//
// Phase 4 will wire `<button onclick=…>` on overlay cards to call this; Phase
// 3 only ships the plumbing.

import { invoke } from '@tauri-apps/api/core';

/**
 * Ask the host to focus the main window on the log row whose
 * `request{id="..."}` span matches `jsonrpcId`.
 *
 * No-op when `jsonrpcId` is null — the overlay still groups by tool, so a
 * card may represent a request the relay emitted before its `request` span
 * was open (no JSON-RPC id captured). Surface a console warning so a
 * dropped click is visible in dev-tools.
 */
export async function focusLogForRequest(jsonrpcId: string | null): Promise<void> {
  if (jsonrpcId == null) {
    console.warn('[overlay] focusLogForRequest called with null jsonrpcId; ignoring');
    return;
  }
  try {
    await invoke('focus_main_window_on_log', { jsonrpcId });
  } catch (e) {
    console.error('[overlay] focus_main_window_on_log failed:', e);
  }
}
