import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { updateStatus, updateVersion, updateError } from './stores';

interface UpdateMetadata {
  version: string;
  current_version: string;
  body: string | null;
  date: string | null;
}

export async function checkForUpdate() {
  updateStatus.set('checking');
  updateError.set(null);
  try {
    const metadata = await invoke<UpdateMetadata | null>('check_for_update');
    if (metadata) {
      updateVersion.set(metadata.version);
      updateStatus.set('available');
    } else {
      updateStatus.set('up-to-date');
      setTimeout(() => updateStatus.set('idle'), 10000);
    }
  } catch (e) {
    updateError.set(e instanceof Error ? e.message : String(e));
    updateStatus.set('error');
  }
}

export async function downloadAndInstall() {
  updateStatus.set('downloading');
  try {
    await invoke('download_and_install_update');
    updateStatus.set('ready');
  } catch (e) {
    updateError.set(e instanceof Error ? e.message : String(e));
    updateStatus.set('error');
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

