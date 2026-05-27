// Shared Svelte store mirroring the persisted `[desktop.overlay]` config
// block. Two surfaces read/write through this store:
//
//   - the Settings view (toggle + position picker + sliders), which
//     optimistically updates the store and calls `set_overlay_settings`;
//   - the overlay window's `OverlayApp`, which subscribes to push opts
//     (`dismissMs`, `maxVisible`, `showProfile`) into its `ToastStore`.
//
// The Rust side emits `overlay:settings-changed` after every successful
// write (from either the command or the tray toggle); `subscribeOverlay
// SettingsChanges` keeps the store in lockstep with that broadcast so
// neither surface drifts. Field names mirror the Rust struct
// `OverlaySettings` exactly (snake_case) — the Tauri payload is the raw
// `serde_json::Value` with `serde(rename_all = "snake_case")`.

import { writable, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type OverlayPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export type OverlaySettings = {
  enabled: boolean;
  position: OverlayPosition;
  auto_dismiss_ms: number;
  max_visible: number;
  show_profile: boolean;
};

// Mirrors the Rust defaults (`OverlaySettings::default`) so the store has a
// sensible value before the first `fetchOverlaySettings` resolves.
export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  enabled: true,
  position: 'bottom-right',
  auto_dismiss_ms: 2000,
  max_visible: 4,
  show_profile: true,
};

// Inclusive bounds enforced by the Rust `sanitize()` method. Exposed here so
// the Settings UI can clamp slider inputs locally without having to wait for
// a backend round-trip rejection.
export const AUTO_DISMISS_MS_MIN = 1000;
export const AUTO_DISMISS_MS_MAX = 10_000;
export const MAX_VISIBLE_MIN = 1;
export const MAX_VISIBLE_MAX = 8;

export const overlaySettings = writable<OverlaySettings>(DEFAULT_OVERLAY_SETTINGS);

/**
 * Read the persisted overlay settings from the Rust side and seed the store.
 * Errors are logged + swallowed (matching `fetchAutoStart`) so a transient
 * backend hiccup leaves the store at its current value rather than crashing
 * the caller.
 */
export async function fetchOverlaySettings(): Promise<void> {
  try {
    const next = await invoke<OverlaySettings>('get_overlay_settings');
    overlaySettings.set(next);
  } catch (e) {
    console.error('[overlay] fetchOverlaySettings failed:', e);
  }
}

/**
 * Optimistically update the store then ask the Rust side to persist + apply
 * the change (build/destroy window, reposition, broadcast event). On
 * failure the store is reverted so the UI keeps matching the on-disk
 * truth — same recovery pattern as `toggleAutoStart`.
 */
export async function updateOverlaySettings(
  patch: Partial<OverlaySettings>,
): Promise<void> {
  const prev = get(overlaySettings);
  const next: OverlaySettings = { ...prev, ...patch };
  overlaySettings.set(next);
  try {
    await invoke('set_overlay_settings', { settings: next });
  } catch (e) {
    overlaySettings.set(prev);
    console.error('[overlay] updateOverlaySettings failed:', e);
    throw e;
  }
}

/**
 * Listen for `overlay:settings-changed` from the Rust side and push the
 * payload into the store. Returns an `UnlistenFn`-shaped disposer so
 * callers can clean up on unmount.
 *
 * The Rust side emits this event after every successful settings write
 * (Settings UI + tray toggle), so renderers that did NOT initiate the
 * change still receive the new opts without polling.
 */
export async function subscribeOverlaySettingsChanges(): Promise<UnlistenFn> {
  return listen<OverlaySettings>('overlay:settings-changed', (event) => {
    overlaySettings.set(event.payload);
  });
}
