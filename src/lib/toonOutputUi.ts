import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { toonOutput } from './stores';
import { reloadConfig } from './api';

// Read the TOON output setting from the Tauri backend, which reads
// `~/.endara/config.toml` directly. The relay is intentionally NOT in the
// read path: a cold-started UI used to call `getConfig` against the relay
// while the relay socket was still coming up, race-losing and leaving the
// toggle stuck at the default `true` even when the on-disk config had it
// disabled.
export async function fetchToonOutput(): Promise<void> {
  try {
    const enabled = await invoke<boolean>('get_toon_output');
    toonOutput.set(enabled);
  } catch (e) {
    // Swallow and leave the store at its current value; matches the prior
    // "default-and-move-on" behavior so a transient failure never throws
    // during Settings mount.
    console.error('Failed to get TOON output:', e);
  }
}

// Toggle TOON output: write through Tauri (which updates
// `~/.endara/config.toml`), then ask the running relay to re-read its
// config so the live sidecar picks up the new value without a restart.
// Optimistically flips the store first and reverts on failure.
export async function toggleToonOutput(): Promise<void> {
  const newValue = !get(toonOutput);
  toonOutput.set(newValue);
  try {
    await invoke('set_toon_output', { enabled: newValue });
    await reloadConfig();
  } catch (e) {
    toonOutput.set(!newValue);
    console.error('Failed to set TOON output:', e);
  }
}
