import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { relayLogLines, relaySidecarStatus, relaySidecarError } from './stores';
import type { RelaySidecarStatusType } from './stores';
import { parseLogLine } from './logParser';

let initialized = false;

type RelaySidecarStatusSnapshot = {
  status: string;
  error?: string | null;
};

function applySidecarStatus(status: string, error?: string | null) {
  relaySidecarStatus.set(status as RelaySidecarStatusType);
  if (status === 'running') {
    relaySidecarError.set(null);
  } else if ((status === 'failed' || status === 'restarting') && error) {
    relaySidecarError.set(error);
  }
}

export async function initRelayLogListener() {
  if (initialized) return;
  initialized = true;

  const listenerRegistrations = [
    listen<{ level: string; message: string; endpoint?: string | null }>('relay-log', (event) => {
    const line = parseLogLine(event.payload.level || 'info', event.payload.message, {
      endpointOverride: event.payload.endpoint,
    });
    relayLogLines.update((lines) => {
      const updated = [...lines, line];
      return updated.length > 5000 ? updated.slice(-5000) : updated;
    });
  }).catch((e) => {
    console.error('Failed to listen for relay-log events:', e);
  }),

    listen<{ status: string; message: string | null }>('relay-health', () => {
    // relay-health events are handled via relay-sidecar-status
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

  // Replay any buffered logs that arrived before the listener was ready
  try {
    const buffered = await invoke<Array<{ level: string; message: string; endpoint?: string | null }>>('get_buffered_relay_logs');
    if (buffered && buffered.length > 0) {
      const lines = buffered.map((entry) =>
        parseLogLine(entry.level || 'info', entry.message, { endpointOverride: entry.endpoint }),
      );
      relayLogLines.update(existing => {
        const merged = [...lines, ...existing];
        return merged.length > 5000 ? merged.slice(-5000) : merged;
      });
    }
  } catch (e) {
    console.error('Failed to get buffered relay logs:', e);
  }

  try {
    const { status, error } = await invoke<RelaySidecarStatusSnapshot>('get_sidecar_status');
    applySidecarStatus(status, error);
  } catch (e) {
    console.error('Failed to get current relay sidecar status:', e);
  }
}

