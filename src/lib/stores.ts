import { writable, derived } from 'svelte/store';
import type { Endpoint, Theme } from './types';

export const endpoints = writable<Endpoint[]>([]);
export const selectedEndpoint = writable<string | null>(null);
export const jsExecutionMode = writable<boolean>(false);

function createThemeStore() {
  const stored = typeof window !== 'undefined' ? localStorage.getItem('endara-theme') as Theme | null : null;
  const store = writable<Theme>(stored || 'system');

  if (typeof window !== 'undefined') {
    store.subscribe((t) => {
      localStorage.setItem('endara-theme', t);
      const root = document.documentElement;
      if (t === 'dark') {
        root.classList.add('dark');
      } else if (t === 'light') {
        root.classList.remove('dark');
      } else {
        // system — follow OS preference
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        root.classList.toggle('dark', prefersDark);
      }
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      let currentTheme: Theme = 'system';
      const unsub = store.subscribe((v) => { currentTheme = v; });
      unsub();
      if (currentTheme === 'system') {
        document.documentElement.classList.toggle('dark', e.matches);
      }
    });
  }

  return store;
}

export const theme = createThemeStore();
export const searchQuery = writable<string>('');
export const activeTab = writable<'tools' | 'logs' | 'config'>('tools');
export const activeTopLevelTab = writable<'servers' | 'unified-catalog' | 'relay-logs' | 'settings'>('servers');

export interface RelayLogLine {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export const relayLogLines = writable<RelayLogLine[]>([]);
export const miniPlayerMode = writable<boolean>(false);

export const relayConnected = writable<boolean>(false);
export const onboardingDismissed = writable<boolean>(false);
export const initialLoadComplete = writable<boolean>(false);

export type RelaySidecarStatusType = 'unknown' | 'starting' | 'running' | 'failed' | 'stopped';
export const relaySidecarStatus = writable<RelaySidecarStatusType>('unknown');
export const relaySidecarError = writable<string | null>(null);

function createRelayPortStore() {
  const stored = typeof window !== 'undefined' ? localStorage.getItem('endara-relay-port') : null;
  const store = writable<number>(stored ? parseInt(stored, 10) : 9400);
  if (typeof window !== 'undefined') {
    store.subscribe(v => localStorage.setItem('endara-relay-port', String(v)));
  }
  return store;
}
export const relayPort = createRelayPortStore();

export const showOnboarding = derived(
  [endpoints, onboardingDismissed, initialLoadComplete],
  ([$endpoints, $onboardingDismissed, $initialLoadComplete]) => {
    return $initialLoadComplete && $endpoints.length === 0 && !$onboardingDismissed;
  }
);

export const filteredEndpoints = derived(
  [endpoints, searchQuery],
  ([$endpoints, $searchQuery]) => {
    if (!$searchQuery) return $endpoints;
    const q = $searchQuery.toLowerCase();
    return $endpoints.filter(
      (ep) =>
        ep.name.toLowerCase().includes(q) ||
        ep.transport.toLowerCase().includes(q)
    );
  }
);

export const groupedEndpoints = derived(filteredEndpoints, ($filtered) => {
  const groups: Record<string, Endpoint[]> = {
    healthy: [],
    degraded: [],
    error: [],
    offline: [],
    unknown: [],
    disabled: [],
  };
  for (const ep of $filtered) {
    if (ep.disabled) {
      groups.disabled.push(ep);
    } else if (ep.error) {
      groups.error.push(ep);
    } else {
      const key = ep.health in groups ? ep.health : 'unknown';
      groups[key].push(ep);
    }
  }
  return groups;
});

export const selectedEndpointData = derived(
  [endpoints, selectedEndpoint],
  ([$endpoints, $selected]) => {
    if (!$selected) return null;
    return $endpoints.find((ep) => ep.name === $selected) ?? null;
  }
);

// Update state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error'
export const updateStatus = writable<string>('idle');
export const updateVersion = writable<string | null>(null);
export const updateError = writable<string | null>(null);

