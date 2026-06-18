// Helper invoked from the overlay window when a card is clicked. Asks the
// host (Rust) to show + focus the main window and emit an `overlay:focus-call`
// window event to the main window so its Observability view can filter the
// call list to the matching row (keyed by the relay-minted `request_uid`).

import { invoke } from '@tauri-apps/api/core';

/**
 * Ask the host to focus the main window on the Observability call whose
 * `request_uid` matches `requestUid`.
 *
 * No-op when `requestUid` is null — defensive guard only. The relay mints a
 * `request_uid` per request and emits it on every Started event, so a matched
 * sidecar always supplies an id; a null here would indicate a relay/version
 * mismatch rather than normal operation. Surface a console warning so a
 * dropped click is visible in dev-tools.
 */
export async function focusCallForRequest(requestUid: string | null): Promise<void> {
  if (requestUid == null) {
    console.warn('[overlay] focusCallForRequest called with null requestUid; ignoring');
    return;
  }
  try {
    await invoke('focus_main_window_on_call', { requestUid });
  } catch (e) {
    console.error('[overlay] invoke failed', e);
  }
}
