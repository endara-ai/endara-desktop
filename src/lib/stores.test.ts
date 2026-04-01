import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

describe('stores', () => {
  beforeEach(() => {
    vi.resetModules();
    // Clear localStorage mock
    (localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (localStorage.setItem as ReturnType<typeof vi.fn>).mockClear();
  });

  async function importStores() {
    return await import('./stores');
  }

  describe('endpoints store', () => {
    it('starts with empty array', async () => {
      const { endpoints } = await importStores();
      expect(get(endpoints)).toEqual([]);
    });

    it('can set and read endpoints', async () => {
      const { endpoints } = await importStores();
      const mockEndpoints = [
        { name: 'test', transport: 'stdio' as const, health: 'healthy' as const, tool_count: 3, last_activity: null, disabled: false },
      ];
      endpoints.set(mockEndpoints);
      expect(get(endpoints)).toEqual(mockEndpoints);
    });
  });

  describe('selectedEndpoint store', () => {
    it('starts as null', async () => {
      const { selectedEndpoint } = await importStores();
      expect(get(selectedEndpoint)).toBeNull();
    });

    it('can select an endpoint', async () => {
      const { selectedEndpoint } = await importStores();
      selectedEndpoint.set('my-endpoint');
      expect(get(selectedEndpoint)).toBe('my-endpoint');
    });

    it('can deselect', async () => {
      const { selectedEndpoint } = await importStores();
      selectedEndpoint.set('my-endpoint');
      selectedEndpoint.set(null);
      expect(get(selectedEndpoint)).toBeNull();
    });
  });

  describe('jsExecutionMode store', () => {
    it('defaults to false', async () => {
      const { jsExecutionMode } = await importStores();
      expect(get(jsExecutionMode)).toBe(false);
    });

    it('can toggle to true', async () => {
      const { jsExecutionMode } = await importStores();
      jsExecutionMode.set(true);
      expect(get(jsExecutionMode)).toBe(true);
    });
  });

  describe('theme store', () => {
    it('defaults to system when no localStorage value', async () => {
      const { theme } = await importStores();
      expect(get(theme)).toBe('system');
    });

    it('persists to localStorage on change', async () => {
      const { theme } = await importStores();
      theme.set('dark');
      expect(localStorage.setItem).toHaveBeenCalledWith('endara-theme', 'dark');
    });

    it('can be set to light', async () => {
      const { theme } = await importStores();
      theme.set('light');
      expect(get(theme)).toBe('light');
      expect(localStorage.setItem).toHaveBeenCalledWith('endara-theme', 'light');
    });
  });

  describe('searchQuery store', () => {
    it('defaults to empty string', async () => {
      const { searchQuery } = await importStores();
      expect(get(searchQuery)).toBe('');
    });
  });

  describe('filteredEndpoints derived store', () => {
    it('returns all endpoints when no search query', async () => {
      const { endpoints, searchQuery, filteredEndpoints } = await importStores();
      const mockEps = [
        { name: 'alpha', transport: 'stdio' as const, health: 'healthy' as const, tool_count: 1, last_activity: null, disabled: false },
        { name: 'beta', transport: 'sse' as const, health: 'offline' as const, tool_count: 0, last_activity: null, disabled: false },
      ];
      endpoints.set(mockEps);
      searchQuery.set('');
      expect(get(filteredEndpoints)).toEqual(mockEps);
    });

    it('filters by name', async () => {
      const { endpoints, searchQuery, filteredEndpoints } = await importStores();
      const mockEps = [
        { name: 'alpha', transport: 'stdio' as const, health: 'healthy' as const, tool_count: 1, last_activity: null, disabled: false },
        { name: 'beta', transport: 'sse' as const, health: 'offline' as const, tool_count: 0, last_activity: null, disabled: false },
      ];
      endpoints.set(mockEps);
      searchQuery.set('alpha');
      expect(get(filteredEndpoints)).toHaveLength(1);
      expect(get(filteredEndpoints)[0].name).toBe('alpha');
    });
  });

  describe('showOnboarding derived store', () => {
    it('shows when no endpoints, not dismissed, and initial load complete', async () => {
      const { endpoints, onboardingDismissed, initialLoadComplete, showOnboarding } = await importStores();
      endpoints.set([]);
      onboardingDismissed.set(false);
      initialLoadComplete.set(true);
      expect(get(showOnboarding)).toBe(true);
    });

    it('hides when dismissed', async () => {
      const { endpoints, onboardingDismissed, initialLoadComplete, showOnboarding } = await importStores();
      endpoints.set([]);
      onboardingDismissed.set(true);
      initialLoadComplete.set(true);
      expect(get(showOnboarding)).toBe(false);
    });

    it('hides before initial load completes', async () => {
      const { endpoints, onboardingDismissed, initialLoadComplete, showOnboarding } = await importStores();
      endpoints.set([]);
      onboardingDismissed.set(false);
      initialLoadComplete.set(false);
      expect(get(showOnboarding)).toBe(false);
    });

    it('shows even when relay sidecar has failed', async () => {
      const { endpoints, onboardingDismissed, initialLoadComplete, relaySidecarStatus, showOnboarding } = await importStores();
      endpoints.set([]);
      onboardingDismissed.set(false);
      initialLoadComplete.set(true);
      relaySidecarStatus.set('failed');
      expect(get(showOnboarding)).toBe(true);
    });
  });



  describe('selectedEndpointData derived store', () => {
    it('returns null when nothing selected', async () => {
      const { selectedEndpointData } = await importStores();
      expect(get(selectedEndpointData)).toBeNull();
    });

    it('returns matching endpoint data', async () => {
      const { endpoints, selectedEndpoint, selectedEndpointData } = await importStores();
      const ep = { name: 'test-ep', transport: 'stdio' as const, health: 'healthy' as const, tool_count: 2, last_activity: null, disabled: false };
      endpoints.set([ep]);
      selectedEndpoint.set('test-ep');
      expect(get(selectedEndpointData)).toEqual(ep);
    });
  });

  describe('relayPort store', () => {
    it('defaults to 9400', async () => {
      const { relayPort } = await importStores();
      expect(get(relayPort)).toBe(9400);
    });
  });
});

