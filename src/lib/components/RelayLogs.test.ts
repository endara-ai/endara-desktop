import { describe, expect, it, beforeEach } from 'vitest';
import { get } from 'svelte/store';

import { selectedEndpoint, activeTopLevelTab } from '$lib/stores';
import { applyGoToEndpoint, toggleEndpointFilter } from './relay-logs-helpers';

// Engineering spec §5 — Slice B test rows #11 (click-to-filter) and #13
// (cross-link to Servers tab). Exercised against the pure helpers extracted
// from `RelayLogs.svelte` so they can run in the Node test env.

describe('toggleEndpointFilter (test #11 — click-to-filter)', () => {
  it('activates the endpoint filter when the row is currently "All"', () => {
    const next = toggleEndpointFilter(new Set(), 'github');
    expect(next).toEqual(new Set(['github']));
  });

  it('clears back to "All" when the only active filter is the clicked endpoint', () => {
    const next = toggleEndpointFilter(new Set(['github']), 'github');
    expect(next.size).toBe(0);
  });

  it('replaces a different active filter with the clicked endpoint', () => {
    const next = toggleEndpointFilter(new Set(['slack']), 'github');
    expect(next).toEqual(new Set(['github']));
  });

  it('replaces a multi-endpoint filter with just the clicked endpoint', () => {
    const next = toggleEndpointFilter(new Set(['slack', 'gmail']), 'github');
    expect(next).toEqual(new Set(['github']));
  });

  it('returns a fresh Set so reactive consumers see a new reference', () => {
    const current = new Set(['slack']);
    const next = toggleEndpointFilter(current, 'github');
    expect(next).not.toBe(current);
    expect(current).toEqual(new Set(['slack']));
  });
});

describe('applyGoToEndpoint (test #13 — cross-link to Servers tab)', () => {
  beforeEach(() => {
    selectedEndpoint.set(null);
    activeTopLevelTab.set('relay-logs');
  });

  it('selects the endpoint and switches to the Servers tab', () => {
    applyGoToEndpoint('github');
    expect(get(selectedEndpoint)).toBe('github');
    expect(get(activeTopLevelTab)).toBe('servers');
  });

  it('overwrites a previously selected endpoint', () => {
    selectedEndpoint.set('slack');
    applyGoToEndpoint('github');
    expect(get(selectedEndpoint)).toBe('github');
    expect(get(activeTopLevelTab)).toBe('servers');
  });

  it('still switches to Servers when the tab was already active', () => {
    activeTopLevelTab.set('servers');
    applyGoToEndpoint('postgres');
    expect(get(activeTopLevelTab)).toBe('servers');
    expect(get(selectedEndpoint)).toBe('postgres');
  });
});
