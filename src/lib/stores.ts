import { writable, derived } from 'svelte/store';
import type { Endpoint, Theme, OAuthStatus } from './types';

export const endpoints = writable<Endpoint[]>([]);
export const selectedEndpoint = writable<string | null>(null);
export const jsExecutionMode = writable<boolean>(false);

function createThemeStore() {
  const stored = typeof window !== 'undefined' ? localStorage.getItem('endara-theme') as Theme | null : null;
  const store = writable<Theme>(stored || 'system');

  // Apply the dark state to <html> using both the legacy `.dark` class and
  // the Endara design-system `[data-theme="dark"]` attribute so selectors
  // in either style resolve correctly while components migrate in Wave 2.
  const applyDark = (isDark: boolean) => {
    const root = document.documentElement;
    root.classList.toggle('dark', isDark);
    if (isDark) {
      root.setAttribute('data-theme', 'dark');
    } else {
      root.removeAttribute('data-theme');
    }
  };

  if (typeof window !== 'undefined') {
    store.subscribe((t) => {
      localStorage.setItem('endara-theme', t);
      if (t === 'dark') {
        applyDark(true);
      } else if (t === 'light') {
        applyDark(false);
      } else {
        // system — follow OS preference
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        applyDark(prefersDark);
      }
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      let currentTheme: Theme = 'system';
      const unsub = store.subscribe((v) => { currentTheme = v; });
      unsub();
      if (currentTheme === 'system') {
        applyDark(e.matches);
      }
    });
  }

  return store;
}

export const theme = createThemeStore();
export const searchQuery = writable<string>('');
export const activeTab = writable<'tools' | 'logs' | 'config' | 'auth'>('tools');
export const oauthStatuses = writable<Map<string, OAuthStatus>>(new Map());
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

// Welcome ("Onboarding") should only appear once we have a definitive answer
// from the relay: the initial poll succeeded (`initialLoadComplete`), the relay
// is reachable (`relayConnected`), and it reported zero endpoints. Otherwise
// during cold-start we'd flash Welcome between a blank list and the real list.
export const showOnboarding = derived(
  [endpoints, onboardingDismissed, initialLoadComplete, relayConnected],
  ([$endpoints, $onboardingDismissed, $initialLoadComplete, $relayConnected]) => {
    return (
      $initialLoadComplete &&
      $relayConnected &&
      $endpoints.length === 0 &&
      !$onboardingDismissed
    );
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
    starting: [],
    degraded: [],
    error: [],
    failed: [],
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
export const updateChannel = writable<'stable' | 'beta'>('stable');
// The channel that was actually used on the most recent update check, sourced
// from the Rust `update://checked` event. Null until the first check runs.
export const lastCheckedChannel = writable<'stable' | 'beta' | null>(null);

