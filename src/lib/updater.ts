import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { updateStatus, updateVersion, updateError } from './stores';
import { get } from 'svelte/store';

interface UpdateMetadata {
  version: string;
  current_version: string;
  body: string | null;
  date: string | null;
}

/**
 * Check for updates. If an update is available, returns true.
 * Does not automatically download - call checkAndAutoDownload() for that behavior.
 */
export async function checkForUpdate(): Promise<boolean> {
  updateStatus.set('checking');
  updateError.set(null);
  try {
    const metadata = await invoke<UpdateMetadata | null>('check_for_update');
    if (metadata) {
      updateVersion.set(metadata.version);
      updateStatus.set('available');
      return true;
    } else {
      updateStatus.set('up-to-date');
      setTimeout(() => updateStatus.set('idle'), 10000);
      return false;
    }
  } catch (e) {
    updateError.set(e instanceof Error ? e.message : String(e));
    updateStatus.set('error');
    return false;
  }
}

/**
 * Download and install a pending update.
 * Returns true if download succeeded, false otherwise.
 */
export async function downloadAndInstall(): Promise<boolean> {
  updateStatus.set('downloading');
  try {
    await invoke('download_and_install_update');
    updateStatus.set('ready');
    return true;
  } catch (e) {
    updateError.set(e instanceof Error ? e.message : String(e));
    updateStatus.set('error');
    return false;
  }
}

/**
 * Show a system notification that an update is ready to install.
 */
export async function showUpdateNotification(version: string): Promise<void> {
  try {
    await invoke('show_update_notification', { version });
  } catch (e) {
    console.error('Failed to show update notification:', e);
  }
}

/**
 * Check for updates and automatically download if available.
 * Shows a system notification when the update is ready.
 * Skips if already downloading or ready.
 */
export async function checkAndAutoDownload(): Promise<void> {
  const currentStatus = get(updateStatus);

  // Skip if already downloading or ready
  if (currentStatus === 'downloading' || currentStatus === 'ready') {
    return;
  }

  const hasUpdate = await checkForUpdate();
  if (hasUpdate) {
    const downloadSuccess = await downloadAndInstall();
    if (downloadSuccess) {
      const version = get(updateVersion);
      if (version) {
        await showUpdateNotification(version);
      }
    }
  }
}

export async function restartApp() {
  await relaunch();
}

export async function getUpdateChannel(): Promise<string> {
  return invoke<string>('get_update_channel');
}

export async function setUpdateChannel(channel: 'stable' | 'beta'): Promise<void> {
  await invoke('set_update_channel', { channel });
}

