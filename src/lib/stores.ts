import { writable, derived } from 'svelte/store';
import type { Endpoint, Theme } from './types';

export const endpoints = writable<Endpoint[]>([]);
export const selectedEndpoint = writable<string | null>(null);
export const jsExecutionMode = writable<boolean>(false);
export const theme = writable<Theme>('system');
export const searchQuery = writable<string>('');
export const isSettingsOpen = writable<boolean>(false);
export const activeTab = writable<'tools' | 'logs' | 'config'>('tools');
export const miniPlayerMode = writable<boolean>(false);

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
    offline: [],
    unknown: [],
  };
  for (const ep of $filtered) {
    const key = ep.health in groups ? ep.health : 'unknown';
    groups[key].push(ep);
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

