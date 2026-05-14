import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { jsExecutionMode } from './stores';
import { reloadConfig } from './api';

// Read the JS execution mode from the Tauri backend, which reads
// `~/.endara/config.toml` directly. The relay is intentionally NOT in the
// read path: a cold-started UI used to call `getConfig` against the relay
// while the relay socket was still coming up, race-losing and leaving the
// toggle stuck at the default `false` even when the on-disk config had it
// enabled.
export async function fetchJsExecutionMode(): Promise<void> {
  try {
    const enabled = await invoke<boolean>('get_js_execution_mode');
    jsExecutionMode.set(enabled);
  } catch (e) {
    // Swallow and leave the store at its current value; matches the prior
    // "default-and-move-on" behavior so a transient failure never throws
    // during Settings mount.
    console.error('Failed to get JS execution mode:', e);
  }
}

// Toggle JS execution mode: write through Tauri (which updates
// `~/.endara/config.toml`), then ask the running relay to re-read its
// config so the live sidecar picks up the new value without a restart.
// Optimistically flips the store first and reverts on failure.
export async function toggleJsExecutionMode(): Promise<void> {
  const newValue = !get(jsExecutionMode);
  jsExecutionMode.set(newValue);
  try {
    await invoke('set_js_execution_mode', { enabled: newValue });
    await reloadConfig();
  } catch (e) {
    jsExecutionMode.set(!newValue);
    console.error('Failed to set JS execution mode:', e);
  }
}

