import { writable, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';

// Shared autostart state. Both Onboarding and Settings used to read/write
// this independently via `invoke('get_autostart')` / `invoke('set_autostart')`,
// which meant toggling in one view didn't update the other. Now the store
// is the single source of truth and the helpers below are the only Tauri
// call path.
export const autoStartEnabled = writable<boolean>(false);

// Read the autostart state from the Tauri backend and update the store.
// Failures are swallowed (matching prior per-component behavior) so a
// transient backend hiccup doesn't crash component mount; the store keeps
// its current value.
export async function fetchAutoStart(): Promise<void> {
  try {
    const enabled = await invoke<boolean>('get_autostart');
    autoStartEnabled.set(enabled);
  } catch (e) {
    console.error('Failed to get autostart:', e);
  }
}

// Optimistically flip the store, then ask the Tauri backend to persist.
// On failure we revert the store so the UI reflects the on-disk truth.
export async function toggleAutoStart(): Promise<void> {
  const newValue = !get(autoStartEnabled);
  autoStartEnabled.set(newValue);
  try {
    await invoke('set_autostart', { enabled: newValue });
  } catch (e) {
    autoStartEnabled.set(!newValue);
    console.error('Failed to set autostart:', e);
  }
}

