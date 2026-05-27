// Thin action helpers extracted from `OverlayCard.svelte` / `OverlayApp.svelte`
// so they can be exercised in the Node test env (vitest runs without jsdom).
// These mirror exactly what the corresponding components run on user input.

import { invoke } from '@tauri-apps/api/core';
import type { ToolCallGroup } from './toastStore';
import { canFocusLog, latestRequest } from './overlay-helpers';
import { focusLogForRequest } from './focusLog';

/**
 * Card click: focus the matching log row in the main window when the
 * group's latest request carries a jsonrpc_id. Otherwise no-op (the card
 * is also rendered non-clickable in the UI).
 */
export async function cardClick(group: ToolCallGroup): Promise<void> {
  if (!canFocusLog(group)) return;
  const last = latestRequest(group);
  await focusLogForRequest(last?.jsonrpcId ?? null);
}

/** Overlay window pointer enter — re-enable cursor events on the host window. */
export async function overlayPointerEnter(): Promise<void> {
  try {
    await invoke('set_overlay_ignore_cursor_events', { ignore: false });
  } catch (e) {
    console.warn('[overlay] set_overlay_ignore_cursor_events(false) failed:', e);
  }
}

/** Overlay window pointer leave — restore click-through. */
export async function overlayPointerLeave(): Promise<void> {
  try {
    await invoke('set_overlay_ignore_cursor_events', { ignore: true });
  } catch (e) {
    console.warn('[overlay] set_overlay_ignore_cursor_events(true) failed:', e);
  }
}
