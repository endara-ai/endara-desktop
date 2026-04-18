import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { updateStatus, updateVersion, updateError, updateChannel, lastCheckedChannel } from './stores';
import { get } from 'svelte/store';

interface UpdateMetadata {
  version: string;
  current_version: string;
  body: string | null;
  date: string | null;
}

/**
 * Read the persisted update channel from the Rust backend and push it into the
 * `updateChannel` store. Called before every update check so the toggle in
 * Settings cannot visually drift from the value actually used by the updater.
 */
export async function syncUpdateChannel(): Promise<'stable' | 'beta' | null> {
  try {
    const channel = await getUpdateChannel();
    if (channel === 'stable' || channel === 'beta') {
      updateChannel.set(channel);
      return channel;
    }
  } catch (e) {
    console.error('Failed to sync update channel from backend:', e);
  }
  return null;
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

  // Re-read the channel from the backend on every check so the UI can't drift
  // from the persisted value the updater will actually use.
  const effectiveChannel = await syncUpdateChannel();
  if (effectiveChannel) {
    console.log(`[updater] checking ${effectiveChannel} channel`);
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

/**
 * Register a listener for the `update://checked` event emitted from Rust on
 * every `check_for_update` call. Populates `lastCheckedChannel` and logs the
 * effective feed URL. Returns an unlisten function.
 */
export async function listenForUpdateChecks(): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<{ channel: string; url: string }>('update://checked', (event) => {
    const { channel, url } = event.payload;
    if (channel === 'stable' || channel === 'beta') {
      lastCheckedChannel.set(channel);
      // Keep the channel store aligned with the channel the backend actually used.
      updateChannel.set(channel);
    }
    console.log(`[updater] backend checked ${channel} feed at ${url}`);
  });
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

