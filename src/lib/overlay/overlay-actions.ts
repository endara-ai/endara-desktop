// Thin action helpers extracted from `OverlayCard.svelte` / `ToastFeed.svelte`
// so they can be exercised in the Node test env (vitest runs without jsdom).
// These mirror exactly what the corresponding components run.

import { invoke } from '@tauri-apps/api/core';
import type { ToolCallGroup } from './toastStore';
import { canFocusLog, latestRequest, type HitRect } from './overlay-helpers';
import { focusCallForRequest } from './focusCall';

/**
 * Card click: focus the matching call row in the main window's Observability
 * tab when the group's latest request carries a request_uid. Otherwise no-op
 * (the card is also rendered non-clickable in the UI).
 */
export async function cardClick(group: ToolCallGroup): Promise<void> {
  if (!canFocusLog(group)) return;
  const last = latestRequest(group);
  await focusCallForRequest(last?.logId ?? null);
}

/**
 * Report the visible card hit rects to Rust. The Rust-side cursor poller
 * (see `update_hit_rects` in `src-tauri/src/overlay.rs`) polls the global
 * cursor position while rects are non-empty and toggles the window's
 * ignore-cursor-events flag on inside/outside transitions. An empty list
 * stops the poller and restores click-through.
 */
export async function reportOverlayHitRects(rects: HitRect[]): Promise<void> {
  try {
    await invoke('set_overlay_hit_rects', { rects });
  } catch (e) {
    console.warn('[overlay] set_overlay_hit_rects failed:', e);
  }
}
