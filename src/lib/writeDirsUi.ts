import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { writeDirs } from './stores';
import { reloadConfig } from './api';

// Read the sandbox write-directory list from the Tauri backend, which reads
// `~/.endara/config.toml` directly. Mirrors `fetchToonOutput`: the relay is
// intentionally NOT in the read path so a cold-started UI never races the
// relay socket coming up.
export async function fetchWriteDirs(): Promise<void> {
  try {
    const dirs = await invoke<string[]>('get_write_dirs');
    writeDirs.set(dirs);
  } catch (e) {
    // Swallow and leave the store at its current value so a transient
    // failure never throws during Settings mount.
    console.error('Failed to get write directories:', e);
  }
}

// Persist a new directory list: write through Tauri (which updates
// `~/.endara/config.toml`), then ask the running relay to re-read its config
// so the live sidecar picks up the list without a restart. Optimistically
// updates the store first and reverts on failure — same shape as
// `toggleToonOutput`.
async function persistWriteDirs(next: string[]): Promise<void> {
  const prior = get(writeDirs);
  writeDirs.set(next);
  try {
    await invoke('set_write_dirs', { dirs: next });
    await reloadConfig();
  } catch (e) {
    writeDirs.set(prior);
    console.error('Failed to set write directories:', e);
  }
}

// Add a directory to the list. Duplicate selections are a no-op so repeated
// picker choices never produce duplicate entries.
export async function addWriteDir(dir: string): Promise<void> {
  const current = get(writeDirs);
  if (current.includes(dir)) return;
  await persistWriteDirs([...current, dir]);
}

// Remove a directory from the list.
export async function removeWriteDir(dir: string): Promise<void> {
  const current = get(writeDirs);
  if (!current.includes(dir)) return;
  await persistWriteDirs(current.filter((d) => d !== dir));
}
