import { writable, type Readable } from 'svelte/store';
import type { OAuthStatus } from '$lib/types';
import { getOAuthStatus } from '$lib/api';
import { oauthStatuses } from '$lib/stores';

const DEFAULT_INTERVAL_MS = 30_000;

export interface OAuthStatusPoller {
  start: () => void;
  stop: () => void;
  status: Readable<OAuthStatus | null>;
}

export function createOAuthStatusPoller(
  endpointName: string,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): OAuthStatusPoller {
  const status = writable<OAuthStatus | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function poll(): Promise<void> {
    try {
      const result = await getOAuthStatus(endpointName);
      status.set(result);
      oauthStatuses.update((map) => {
        const next = new Map(map);
        next.set(endpointName, result);
        return next;
      });
    } catch {
      status.set(null);
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    // Fire immediately, then at interval
    poll();
    timer = setInterval(poll, intervalMs);
  }

  function stop(): void {
    running = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    status: { subscribe: status.subscribe },
  };
}

