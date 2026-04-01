import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { relayLogLines, relayLastError, relaySidecarStatus, relaySidecarError } from './stores';
import type { RelayLogLine, RelaySidecarStatusType } from './stores';

let initialized = false;

type RelaySidecarStatusSnapshot = {
  status: string;
  error?: string | null;
};

function applySidecarStatus(status: string, error?: string | null) {
  relaySidecarStatus.set(status as RelaySidecarStatusType);
  if (status === 'running') {
    relaySidecarError.set(null);
  } else if (status === 'failed' && error) {
    relaySidecarError.set(error);
  }
}

export async function initRelayLogListener() {
  if (initialized) return;
  initialized = true;

  const listenerRegistrations = [
    listen<{ level: string; message: string }>('relay-log', (event) => {
    const line: RelayLogLine = {
      timestamp: new Date().toLocaleTimeString(),
      level: (event.payload.level as RelayLogLine['level']) || 'info',
      message: event.payload.message,
    };
    relayLogLines.update((lines) => {
      const updated = [...lines, line];
      return updated.length > 5000 ? updated.slice(-5000) : updated;
    });
  }).catch((e) => {
    console.error('Failed to listen for relay-log events:', e);
  }),

    listen<{ status: string; message: string | null }>('relay-health', (event) => {
    const { status, message } = event.payload;
    if (status === 'error' && message) {
      relayLastError.set(message);
    } else if (status === 'connected') {
      relayLastError.set(null);
    }
  }).catch((e) => {
    console.error('Failed to listen for relay-health events:', e);
  }),

    listen<{ status: string; error?: string | null }>('relay-sidecar-status', (event) => {
    const { status, error } = event.payload;
    applySidecarStatus(status, error);
  }).catch((e) => {
    console.error('Failed to listen for relay-sidecar-status events:', e);
  }),
  ];

  await Promise.allSettled(listenerRegistrations);

  try {
    const { status, error } = await invoke<RelaySidecarStatusSnapshot>('get_sidecar_status');
    applySidecarStatus(status, error);
  } catch (e) {
    console.error('Failed to get current relay sidecar status:', e);
  }
}

