import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { updateStatus, updateVersion, updateError } from './stores';

let updateInstance: Update | null = null;

export async function checkForUpdate() {
  updateStatus.set('checking');
  updateError.set(null);
  try {
    const update = await check();
    if (update) {
      updateVersion.set(update.version);
      updateStatus.set('available');
      updateInstance = update;
    } else {
      updateStatus.set('up-to-date');
      // Reset to idle after 10s
      setTimeout(() => updateStatus.set('idle'), 10000);
    }
  } catch (e) {
    updateError.set(e instanceof Error ? e.message : String(e));
    updateStatus.set('error');
  }
}

export async function downloadAndInstall() {
  if (!updateInstance) return;
  updateStatus.set('downloading');
  try {
    await updateInstance.downloadAndInstall();
    updateStatus.set('ready');
  } catch (e) {
    updateError.set(e instanceof Error ? e.message : String(e));
    updateStatus.set('error');
  }
}

export async function restartApp() {
  await relaunch();
}

